# Database Runbooks

PostgreSQL runs on RDS (`terraform/modules/postgres` via the root module). The
backend uses an `sqlx::PgPool` sized by `PREDIFI_DB_MAX_CONNECTIONS` (default
10 per instance).

## Connection budget

Every service that opens a pool counts against the RDS `max_connections`
limit. During a rolling deploy or a scale-out, old and new replicas overlap, so
the budget must be computed from **peak** replica counts, not steady state.

Inventory (keep this table in sync with the Terraform variables and the
`PREDIFI_DB_MAX_CONNECTIONS` defaults):

| Service | Pool size per replica | Max replicas (steady) | Peak replicas (rolling deploy) | Peak connections |
| --- | --- | --- | --- | --- |
| backend | `PREDIFI_DB_MAX_CONNECTIONS` (10) | `backend_max_replicas` (6) | steady + `backend_max_surge` (2) = 8 | 80 |
| indexer | `PREDIFI_DB_MAX_CONNECTIONS` (5) | `indexer_max_replicas` (2) | steady + `indexer_max_surge` (1) = 3 | 15 |
| migrations / jobs | 1 per job | 1 | 2 (overlapping deploy + manual run) | 2 |
| **Total application** | | | | **97** |

Global budget: **application peak connections must stay at or below 80% of
RDS `max_connections`**, leaving at least 20% headroom for administration
(bastion sessions, `pg_dump`/restore, monitoring, RDS maintenance). With the
default `max_connections` of 150 the ceiling is 120 connections; the inventory
above (97) fits with 23 connections of margin. Raising any pool size or max
replica count requires re-checking this table and the RDS parameter.

### Deployment check

`scripts/check_db_connection_budget.sh` (run in CI before deploy and as a
pre-deploy gate in the release pipeline) reads the pool sizes and replica
counts from the environment/Terraform outputs, computes the peak connection
total, and compares it to the RDS `max_connections` limit. It **fails the
deploy** (non-zero exit) when:

- peak application connections exceed 80% of `max_connections`, or
- the computed total exceeds `max_connections` outright, or
- a pool size or replica count is missing/unparseable (no silent defaults).

To validate a change, run it against the staging profile with peak replica
counts:

```bash
PREDIFI_ENV=staging scripts/check_db_connection_budget.sh
```

The script prints the per-service breakdown, the calculated maximum, and the
remaining headroom. If it fails, lower a pool size or max replica count, or
raise RDS `max_connections` (and re-verify memory headroom on the instance
class) before merging.

> **Known gap:** `db_pool_utilization_ratio` is documented in
> `backend/src/db/README.md` but not registered in `backend/src/metrics.rs`.
> Until it is, the two pool alerts below have no data; use the
> `pg_stat_activity` queries instead.

Useful SQL (run from a bastion with a read-only role where possible):

```sql
-- Connections by state and application
SELECT application_name, state, count(*) FROM pg_stat_activity GROUP BY 1, 2 ORDER BY 3 DESC;

-- Longest-running transactions
SELECT pid, now() - xact_start AS duration, state, left(query, 120)
FROM pg_stat_activity WHERE state <> 'idle' ORDER BY duration DESC NULLS LAST LIMIT 10;

-- Who is waiting on locks
SELECT pid, wait_event_type, wait_event, left(query, 120)
FROM pg_stat_activity WHERE wait_event_type = 'Lock';
```

---

## DatabaseConnectionPoolSaturated

**Owner:** backend-oncall · **Severity:** warning

**User impact:** None yet. More than 80% of pool connections are in use, so a
burst of traffic or one slow query will start queueing requests.

**Dashboards & queries:**
- `db_pool_utilization_ratio`, `db_pool_active` (see known gap above).
- Query rate by type: `sum by (query_type) (rate(app_db_queries_total[5m]))`
- RDS console → *DatabaseConnections*, *CPUUtilization*.

**Diagnosis:**
1. Run the *longest-running transactions* query. A few long transactions
   holding connections is the most common cause.
2. Compare request volume to last week. Higher traffic with no slow queries
   means the pool is simply too small.
3. Check whether a migration is running (it holds a connection and may hold
   locks others wait on).

**Safe mitigation:**
1. **Stuck query:** `SELECT pg_cancel_backend(<pid>);`
2. **Legitimate traffic growth:** add a backend instance (more pools) before
   raising `PREDIFI_DB_MAX_CONNECTIONS`. Check RDS `max_connections` first:
   instances × pool size must stay below it with headroom for operators. Run
   `scripts/check_db_connection_budget.sh` (see
   [Connection budget](#connection-budget)) to confirm the new peak stays
   within the global budget.

**Verification:** Utilization drops below 80% for 10 minutes.

**Rollback:** Return the instance count or pool size to the previous value.

**Escalation:** Rising toward 95% → treat as
[DatabaseConnectionPoolCritical](#databaseconnectionpoolcritical). RDS capacity
changes → infra-oncall.

---

## DatabaseConnectionPoolCritical

**Owner:** backend-oncall · **Severity:** critical

**User impact:** The pool is almost exhausted. Requests wait up to
`PREDIFI_DB_ACQUIRE_TIMEOUT_SECS` (default 30s) for a connection and then fail
with 5xx. Expect `HighApiErrorRate` and `HighP99Latency` to follow.

**Dashboards & queries:** Same as
[DatabaseConnectionPoolSaturated](#databaseconnectionpoolsaturated), plus the
*who is waiting on locks* query.

**Diagnosis:**
1. Lock waits → find the blocker:
   `SELECT pid, pg_blocking_pids(pid) FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0;`
2. A migration holding an `AccessExclusiveLock` blocks every query on that
   table. Check `_sqlx_migrations` for a row with `success = false` or a
   migration that started recently.
3. No locks, many active queries → traffic spike or a slow query plan.

**Safe mitigation:**
1. **Blocking session:** cancel the blocker with `pg_cancel_backend(<pid>)`.
   Use `pg_terminate_backend` only if cancel does not work within a minute.
2. **Blocking migration:** cancelling it rolls back its transaction. Follow
   the recovery steps for that migration in
   [`docs/MIGRATION_DEPLOYMENT_GUIDE.md`](../MIGRATION_DEPLOYMENT_GUIDE.md)
   before retrying it.
3. **Traffic spike:** add backend instances only if RDS has spare
   `max_connections` (verify with
   `scripts/check_db_connection_budget.sh`); otherwise shed load at the load
   balancer (rate limiting) rather than adding connections.

**Verification:** Utilization below 80%, API 5xx rate back under 1%.

**Rollback:** Re-run a cancelled migration only after its recovery steps are
complete. Remove extra instances once traffic drops.

**Escalation:** Not mitigated in 15 minutes → secondary backend-oncall and
infra-oncall (RDS). Data integrity doubts → `@Web3Novalabs/maintainers`.

---

## DatabaseQueryFailures

**Owner:** backend-oncall · **Severity:** critical

**User impact:** More than 5 queries per second are failing. Reads return
errors and the indexer cannot write, so data goes stale.

**Dashboards & queries:**
- Failures by type: `sum by (query_type) (rate(app_db_queries_total{result="error"}[5m]))`
- Logs (Loki): `{job="predifi", service="backend", level="ERROR"} |~ "(?i)(sqlx|database|postgres)"`
- RDS console → *FreeStorageSpace*, *CPUUtilization*, events.

**Diagnosis:**
1. One `query_type` failing after a deploy → schema/code mismatch. Compare the
   latest `_sqlx_migrations` version with what the running release expects.
2. All query types failing → connectivity, credentials, or storage. Check RDS
   events for failover, storage-full, or maintenance.
3. `deadlock detected` in logs → two code paths taking locks in different order.

**Safe mitigation:**
1. **Schema mismatch after deploy:** roll back the application. Do **not** roll
   back the migration unless its section in the migration guide says it is safe.
2. **Storage full:** increase RDS allocated storage (online). Do not delete data.
3. **Failover in progress:** wait for RDS to finish (usually under 2 minutes);
   the pool reconnects on its own.

**Verification:** `sum(rate(app_db_queries_total{result="error"}[5m]))` is
near 0 for 10 minutes.

**Rollback:** Redeploy the newer application release once the schema mismatch
is resolved. Storage increases cannot be reverted and do not need to be.

**Escalation:** Not mitigated in 30 minutes → secondary backend-oncall. RDS
failover, storage, or credential problems → infra-oncall.
