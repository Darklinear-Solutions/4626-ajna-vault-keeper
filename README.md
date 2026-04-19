# 4626 Ajna Vault Keeper

## Overview

The Ajna vault keeper is a permissioned off-chain agent that manages an ERC-4626 vault system built on the Ajna lending protocol. It runs two keepers on a shared interval. The metavault keeper allocates capital across multiple Ajna vaults (called "arks") through an Euler Earn contract, rebalancing based on borrow fee rates and configured allocation limits. The ark keeper then runs for each individual ark, moving quote tokens between Ajna buckets and the Buffer based on bucket price (derived from market price) and vault policy. Together, these keepers channel liquidity toward optimal yield at both the cross-vault and intra-pool levels within predefined bounds. Both keepers are authorised in their respective contracts, run on a fixed interval and follow strict bail-out conditions to avoid unsafe actions.

## Why it Exists

- Allocate capital across multiple Ajna vaults based on borrow fee rates.
- Maintain configured allocation bounds (min/max per ark, buffer target) at the metavault level.
- Maintain a configured Buffer ratio for fast withdrawals at the ark level.
- Consolidate liquidity toward an optimal yielding bucket within each ark.
- Skip actions when the vault or pool is not in a healthy state (paused, bad debt, out-of-range or dusty).

## What it Does

On each run, the keeper checks whether a metavault is configured. If so, the metavault keeper runs first, followed by the ark keeper for each configured ark. The metavault keeper can also be omitted entirely by leaving the metavault address out of the config, in which case only the ark keeper runs.

**Metavault keeper:** Reads the current balance and borrow fee rate for each ark, then determines whether any reallocation is needed. It first enforces allocation bounds by capping arks that exceed their maximum and filling or draining the buffer to its target percentage. It then evaluates rates across arks and moves capital from lower-rate arks to higher-rate arks when the rate difference exceeds a configured threshold (`minRateDiff`). For any ark whose allocation needs to decrease, the metavault keeper executes on-chain `drain` and `moveToBuffer` calls to free funds from the appropriate buckets. Finally, it builds a set of ordered allocations and calls `reallocate()` on the Euler Earn contract.

**Ark keeper:** For each ark, the keeper executes a full decision tree - fetching vault, pool, and buffer state, then it decides whether to continue by checking whether the vault is paused, if the pool has bad debt, and if the optimal bucket is out of range or dusty. If all of these are false, it computes the buffer deficit or surplus targets, as well as the optimal bucket pricing, and executes a rebalancing between buckets, to the buffer or from the buffer as needed. The keeper then concludes with a logging of results for transparency.

## In-Range Boundaries in Ajna

In Ajna, all deposits above the Lowest Utilized Price (LUP) or the Threshold Price of the least collateralized loan, known as the Highest Threshold Price (HTP), earn interest, while deposits below earn no interest. A pool's LUP is defined as the lowest collateral price against which someone is actively borrowing. Therefore, when a bucket is referred to as "in-range", it means that it lies within the band of the Ajna pool where deposits actively earn interest and are considered valid for allocation. Expanding upon the boundary limits:
* The lower boundary is defined as the lowest price between the HTP and the LUP - typically the HTP beyond which, deposits will not be earning interest and need to be moved to a bucket in range.
* The max value, which is defined in the auth contract as the MIN_BUCKET_INDEX, is designed to allow the admin to prevent vault deposits from being lent at disadvantageous prices, and will typically be an index corresponding to a bucket below the current price of the asset.
* The optimal bucket will always fall within this range, and deposits in buckets within this range are not touched in keeper runs except to add to the buffer if necessary (i.e. when in deficit).

Due to LUP and HTP shifting dynamically with pool activity, the in-range boundaries may not be static and as such a target bucket may shift in or out of range over time, which the keeper needs to monitor.

## Technical Overview

1. Configuration is split between `.env` (secrets and infrastructure) and `config.json` (operational parameters). Secrets stay in `.env` and should never be committed. All other configuration lives in `config.json`.

    **Environment variables (set in `.env`):**

    | Variable                         | Description                                                                      | Type                     | Required/Optional                              | Default          |
    | -------------------------------- | -------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------- | ---------------- |
    | `RPC_URL`                        | RPC endpoint used for on-chain interactions.                                     | URL (`https://...`)      | Required                                       | None             |
    | `SUBGRAPH_URL`                   | Subgraph endpoint for pool/vault state queries.                                  | URL (`https://...`)      | Required                                       | None             |
    | `PRIVATE_KEY`                    | Raw private key of the keeper's authorized account. Intended as a headless fallback when the deployer injects it from a secret manager. | Hex string (`0x...`)     | Conditional (exactly one credential mode must be configured) | None             |
    | `KEYSTORE_PATH`                  | Path to an Ethereum V3 keystore file. If set, the keeper prompts for the password on startup. Best suited to local/operator use. | String (file path)       | Conditional (exactly one credential mode must be configured) | None             |
    | `REMOTE_SIGNER_URL`              | Web3Signer-compatible JSON-RPC endpoint used only for signing transactions. Reads, fee estimation, waits, and broadcast still use `RPC_URL`. | URL (`https://...`)      | Conditional (`REMOTE_SIGNER_URL` and `REMOTE_SIGNER_ADDRESS` must be set together as one credential mode) | None             |
    | `REMOTE_SIGNER_ADDRESS`          | EOA address exposed by the remote signer and used as `client.account.address`.   | Ethereum address (`0x...`) | Conditional (`REMOTE_SIGNER_URL` and `REMOTE_SIGNER_ADDRESS` must be set together as one credential mode) | None             |
    | `ORACLE_API_KEY`                 | CoinGecko API key.                                                               | String                   | Optional                                       | None             |
    | `ORACLE_API_TIER`                | CoinGecko tier (`demo`, `pro`).                                                  | String                   | Conditional (if `ORACLE_API_KEY` set)          | None             |
    | `MAINNET_RPC_URL`                | Since the RPC node defined here may refer to any chain, the test suite needs a mainnet RPC for set up. By default, the test suite uses the free node at 'https://eth.drpc.org', but this node is rate-limited, which may cause unexpected test failures. To avoid this, another RPC can be defined here. | String | Optional | None |

    **Credential modes (mutually exclusive):**

    | Mode | Variables | Recommended use |
    | ---- | --------- | --------------- |
    | Remote signer | `REMOTE_SIGNER_URL` + `REMOTE_SIGNER_ADDRESS` | Preferred production posture where available. The keeper talks to a Web3Signer-compatible signer service, so the signing key can stay externalized or non-extractable. |
    | Local keystore | `KEYSTORE_PATH` | Local/operator mode. Startup is interactive: the keystore password is prompted on boot. |
    | Raw private key | `PRIVATE_KEY` | Headless fallback when the deployer must inject the key directly from a secret manager. |

    Remote signer mode is the strongest supported production posture in this repo. Direct AWS KMS integration is not implemented in the keeper itself, but AWS KMS, Vault, and similar custody systems can back a compatible signer service. The minimum expectation is a reachable Web3Signer-compatible JSON-RPC endpoint that signs for the EOA configured in `REMOTE_SIGNER_ADDRESS`. The signer endpoint should stay on a restricted internal network or equivalent access-controlled path, not on the public internet.

    **Config values (set in `config.json`):**

    | Config Key                       | Description                                                                      | Type                     | Required/Optional                              | Default          |
    | -------------------------------- | -------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------- | ---------------- |
    | `chainId`                        | Chain ID for the intended network.                                               | Integer                  | Optional                                       | 1 (Ethereum mainnet) |
    | `quoteTokenAddress`              | Address of the vault's quote token.                                              | Ethereum address (`0x...`) | Required                                     | None             |
    | `metavaultAddress`               | Address of the Euler Earn (metavault) contract. If omitted, only the ark keeper runs. | Ethereum address (`0x...`) | Optional                                   | None             |
    | `keeper.intervalMs`              | Interval between keeper runs.                                                    | Integer (milliseconds)   | Required                                       | 43,200,000 (12h) |
    | `keeper.logLevel`                | Minimum severity of logs (`info`, `warn`, `error`).                              | String                   | Optional                                       | `info`           |
    | `keeper.exitOnSubgraphFailure`   | Abort run if the subgraph query fails during the check for bad debt in the pool. The default is fail-closed. Set this to `false` only if you explicitly prefer availability over the bad-debt guard during subgraph outages. | Boolean                  | Optional                                       | `true`           |
    | `keeper.haltIfLupBelowHtp`       | If operations trigger `LUPBelowHTP` error from Ajna, halt keeper until restarted to prevent more tokens from being added to the pool while move targets are likely to require liquidations. | Boolean | Required                      | N/A              |
    | `oracle.apiUrl`                  | API endpoint for off-chain price oracle using CoinGecko.                         | URL (`https://...`)      | Conditional (if on-chain oracle is not primary and no fixed price is set) | None |
    | `oracle.onchainPrimary`          | Use on-chain oracle as primary instead of CoinGecko.                             | Boolean                  | Required                                       | N/A              |
    | `oracle.onchainAddress`          | Address of Chronicle on-chain oracle.                                            | Ethereum address (`0x...`) | Conditional (if `onchainPrimary` is true)    | None             |
    | `oracle.onchainMaxStaleness`     | Max allowed age of on-chain price data. When omitted and the on-chain oracle is primary, the keeper defaults this to `86400` seconds. Set to `null` only to explicitly disable the staleness check. | Integer (seconds) or `null` | Optional                                  | `86400` when `oracle.onchainPrimary` is `true`, otherwise `null` |
    | `oracle.fixedPrice`              | The keeper can be configured to skip both oracles and use a hard-coded price, defined here. Set to `null` to use the live oracle. The value is parsed as a decimal string into Ajna's 18-decimal price domain, independent of quote-token decimals. Numeric literals are rejected to avoid precision loss. When enabled, the keeper emits a startup warning because this mode bypasses live oracle checks. | String decimal (e.g. `"1.00"`) or `null` | Optional | `null` |
    | `oracle.futureSkewTolerance`     | Max clock drift allowed from Chronicle timestamps.                               | Integer (seconds)        | Optional                                       | 120 (2 minutes)  |
    | `transaction.gasBuffer`          | Accounts for occasional Viem gas underestimation for the functions that interact with Ajna, resulting in sporadic `OutOfGas` reversions. | Integer (percentage)     | Optional                                       | 50 (50%)         |
    | `transaction.defaultGas`         | Default gas limit in the event that gas estimation with the above buffer fails.  | Integer                  | Optional                                       | 1,500,000        |
    | `transaction.confirmations`      | Number of block confirmations to wait for each tx.                               | Integer                  | Required                                       | N/A              |
    | `arkGlobal.optimalBucketDiff`    | Offset (in bucket indexes) from current pool price to select the optimal bucket. Can also be set per ark. | Integer | Conditional (required globally or per ark) | None             |
    | `arkGlobal.bufferPadding`        | Accounts for the slight variation in the value of `totalAssets` (due to interest accruing in Ajna). | String (`WAD`)  | Optional                                       | `"100000000000000"` (1e14) |
    | `arkGlobal.minMoveAmount`        | Skip moves if bucket's quote token balance is below this amount (dust limit) - enforced by vault. | String (`WAD` units)    | Optional                                       | `"1000001"`      |
    | `arkGlobal.minTimeSinceBankruptcy` | Minimum time since bucket bankruptcy to be considered valid. Abort keeper run if timestamp is between this value and current time. | Integer (seconds) | Optional                        | 259,200 (72h)    |
    | `arkGlobal.maxAuctionAge`        | Only consider auctions with bad debt if they are older than this value.          | Integer (seconds)        | Optional                                       | 259,200 (72h)    |
    | `arks[].address`                 | Address of the ark (Ajna vault strategy) registered in the metavault.            | Ethereum address (`0x...`) | Required                                     | None             |
    | `arks[].vaultAddress`            | Address of the ark's vault contract.                                             | Ethereum address (`0x...`) | Required                                     | None             |
    | `arks[].vaultAuthAddress`        | Address of the ark's vault auth contract.                                        | Ethereum address (`0x...`) | Required                                     | None             |
    | `arks[].allocation.min`          | Minimum allocation percentage for this ark.                                      | Integer (percentage)     | Required                                       | N/A              |
    | `arks[].allocation.max`          | Maximum allocation percentage for this ark. Must not be 0.                       | Integer (percentage)     | Required                                       | N/A              |
    | `arks[].optimalBucketDiff`       | Per-ark override for `arkGlobal.optimalBucketDiff`.                              | Integer                  | Optional                                       | `arkGlobal` value |
    | `arks[].bufferPadding`           | Per-ark override for `arkGlobal.bufferPadding`.                                  | String (`WAD`)           | Optional                                       | `arkGlobal` value |
    | `arks[].minMoveAmount`           | Per-ark override for `arkGlobal.minMoveAmount`.                                  | String (`WAD` units)     | Optional                                       | `arkGlobal` value |
    | `arks[].minTimeSinceBankruptcy`  | Per-ark override for `arkGlobal.minTimeSinceBankruptcy`.                         | Integer (seconds)        | Optional                                       | `arkGlobal` value |
    | `arks[].maxAuctionAge`           | Per-ark override for `arkGlobal.maxAuctionAge`.                                  | Integer (seconds)        | Optional                                       | `arkGlobal` value |
    | `buffer.address`                 | Address of the buffer strategy registered in the metavault.                      | Ethereum address (`0x...`) | Required                                     | None             |
    | `buffer.allocation`              | Target allocation percentage for the buffer.                                     | Integer (percentage)     | Required                                       | N/A              |
    | `minRateDiff`                    | Minimum percentage difference in borrow fee rates between two arks before capital is reallocated from the lower-rate ark to the higher-rate ark. | Integer (percentage) | Optional               | 10               |

    The sum of all `arks[].allocation.max` values plus `buffer.allocation` must equal 100. Per-ark settings (`optimalBucketDiff`, `bufferPadding`, `minMoveAmount`, `minTimeSinceBankruptcy`, `maxAuctionAge`) can be set globally in `arkGlobal` or individually per ark. Per-ark values take precedence over global values.

2. Fetching State:

    **Metavault keeper:**
    * `getExpectedSupplyAssets(strategy)` - reads the current balance for each strategy (each ark and the buffer) from the Euler Earn contract. The sum of all strategy balances is the total assets under management.
    * `vault.getBorrowFeeRate()` - reads the borrow fee rate from the Ajna pool associated with each ark. This rate is used to compare yield across arks and decide whether reallocation is warranted.
    * `poolHasBadDebt(vault)` - checks each ark's pool for bad debt (same check as the ark keeper). Arks with bad debt are excluded from receiving capital during reallocation.
    * `poolBalanceCap(balance, vault)` - caps each ark's balance to the actual quote token balance in its pool, preventing the keeper from planning moves for tokens that are not currently available.

    **Ark keeper:**
    
    * Vault Status and configuration:
      * `vault.paused()` - reads the vault's global pause flag. If true, all keeper actions will immediately exit with no state changes.
      * `vault.bufferRatio()` - returns the configured target share of total assets (in basis points) that should be held in the Buffer. The keeper uses this to calculate whether to top up or drain the Buffer during rebalancing.
      * `vault.minBucketIndex()` - returns the configured lower bound for bucket indexes (0 = no restriction). The keeper checks this to ensure the selected optimal bucket is not below the allowed minimum bound.
      * (If exposed) `vault.toll()`, `vault.tax()` - return the configured deposit fee and withdrawal fee (in basis points). These are applied directly by the vault on user deposits and withdrawals, not by the keeper.
    * Pool state
      * `getPrice()` -> `getPriceToIndex(price)` - returns the pool's current price. The keeper reads and converts this into the corresponding bucket index and then applies `optimalBucketDiff` to select the target bucket for rebalancing.
      * `poolHasBadDebt()` - returns true if the pool has unresolved bad debt or active liquidation auctions. If so, the keeper exits immediately without rebalancing to avoid acting in an unhealthy pool state.
    * Buffer/Vault
      * `getBufferTotal()`, `getTotalAssets()` - return the Buffer's current balance and the vault's total assets. The keeper compares these values against `bufferRatio()` to decide whether to top up or drain the Buffer during rebalancing.
      * `getAssetDecimals()`, `getBufferRatio()` - return the asset's decimals and the configured buffer ratio. The keeper uses these to compute the Buffer target (`bufferTarget`) for rebalancing decisions.
      * `Buffer.lpToValue(uint256 lps)` - converts a given amount of LP tokens into the equivalent quote token value. The keeper uses this when sizing potential moves out of buckets, especially to check for "dusty" buckets below the minimum move threshold.
    * Range Math Utilities - from `vault/poolInfoUtils.ts` to derive safe bucket targets for rebalancing:
      * `getLup()` - returns the current LUP (Lowest Utilized Price) of the pool. This is the lowest price bucket where there is a utilized deposit and is used to evaluate safe lower bounds.
      * `getHtp()` - returns the HTP (Highest Threshold Price). This is the threshold price of the least collateralized loan. The keeper uses this to ensure target buckets are not placed above the active debt range.
      * `getPriceToIndex()` - converts a given price into the corresponding bucket index. The keeper uses this to translate the current pool price into an index before applying `optimalBucketDiff`.
      * `getIndexToPrice()` - converts a given bucket index back into its price. The keeper uses this to verify or display the price level of the selected target bucket.

3. <a name="exit-conditions"></a>Early Fail or Skip Conditions:

    **Metavault keeper:**
    * If any ark is paused - the metavault keeper skips the entire run.
    * If the planned reallocation would violate an ark's allocation bounds (below min or above max) - the run is aborted with an error.
    * If the total withdrawn does not equal the total supplied after computing allocations - the run is aborted due to an inconsistent reallocation invariant.
    * If no allocations need to change - the run exits cleanly with no state changes.

    **Ark keeper:**
    
    * If `vault.paused()` is true - the keeper exits immediately with no state changes.
    * If `poolHasBadDebt()` is true - the pool has unresolved bad debt or active liquidations, the keeper exits immediately.
    * If the computed optimal bucket is out of range (below `vault.minBucketIndex()` or above `getHtp()`), the keeper exits early with no moves, leaving bucket balances unchanged.
    * If the computed move size is below the keeper's configured minimum threshold, the action is skipped to avoid dust transfers.
    * If the optimal bucket is dusty (below the dust threshold in LP tokens) then the keeper skips to avoid operating on very small bucket amounts.
    * If the optimal bucket has been bankrupt more recently than the configured `minTimeSinceBankruptcy`, the run is aborted to prevent risky deposits.
    * If the optimal bucket's debt is locked due to an ongoing auction (i.e., withdrawals from the bucket would revert in Ajna with `RemoveDepositLockedByAuctionDebt()`), the run is aborted to prevent locking vault funds in the bucket.

4. Compute Targets:

    **Metavault keeper:**
    * Buffer target is computed as `(totalAssets * buffer.allocation) / 100`. The metavault keeper first caps any arks exceeding their max allocation, then fills or drains the buffer to its target by pulling from or pushing to arks sorted by rate (lowest-rate arks are drained first, highest-rate arks are filled first).
    * Rate evaluation compares borrow fee rates across arks. For each ark, the keeper identifies all other arks whose rate exceeds the current ark's rate by at least `minRateDiff` percent. The threshold check is: `targetRate * 100 >= originRate * (100 + minRateDiff)`.
    * When reallocating for rates, the keeper processes arks from lowest rate to highest. For each ark with available funds (above its min allocation), it moves capital to higher-rate targets (sorted by rate descending) up to each target's max allocation. Arks with bad debt are skipped.

    **Ark keeper:**
    
    * The keeper reads the current pool price (`getPrice()`), normalizes off-chain and fixed-price inputs into Ajna's 18-decimal price domain, converts that price to a bucket index (`getPriceToIndex(price)`), then applies an integer offset `optimalBucketDiff` to produce `optimalBucket`, which `_getKeeperData()` stores for subsequent range checks.
    * Concurrent internal index calculations - `_getKeeperData()` computes `lupIndex`, `htpIndex`, and `optimalBucket` using `Promise.all`, and binds the third value to `optimalBucket`.
    * Buffer target (computed here) & gap (computed later) - `_getKeeperData()` computes `bufferTarget` via `_calculateBufferTarget()`, which multiplies total assets (scaled to WAD using asset decimals) by the configured `bufferRatio` and divides by 10,000 (basis points). It also reads `bufferTotal` with `getBufferTotal()`. The actual deficit/surplus ("gap") is only derived during rebalancing (e.g. `calculateBufferDeficit(data)`), so it is not stored in `_getKeeperData()`.
    * Per-bucket sizing - The keeper sizes per bucket moves by using `lpToValue(bucket)` which provides the quote value used to size moves, whereas `getLpToValue(optimalBucket)` is only used to detect dusty optimal and skip.
    * KeeperRunData payload - `_getKeeperData()` returns `{ buckets, bufferTotal, bufferTarget, price, lup, htp, lupIndex, htpIndex, optimalBucket }`.
    * The keeper then validates `optimalBucket` with `isOptimalBucketInRange(data)`. This uses `getIndexToPrice`, `getLup`, `getHtp`, and `getMinBucketIndex()`, where `buckets` is the per-bucket snapshot the sizing loop iterates over.

5. Execute Rebalancing:

    **Metavault keeper:**
    * For each ark whose computed allocation decreased, the metavault keeper determines which buckets to withdraw from using `selectBuckets(vault, amountToMove)`. This function selects the optimal set of buckets to satisfy the withdrawal amount: if a single bucket has enough value, it is used (preferring the lowest-price bucket among candidates). Otherwise, the function fills greedily from the largest-value buckets first. In all cases, if a partial withdrawal would leave behind LP tokens below the dust threshold, the full bucket value is taken instead.
    * For each selected bucket, the keeper calls `vault.drain(bucket)` to claim pending interest, then `vault.moveToBuffer(bucket, amount)` to move the funds into the buffer.
    * After all `moveToBuffer` calls complete, the keeper builds the final allocation array for the `reallocate()` call. Decreasing allocations are ordered first (withdrawals), then increasing allocations (deposits). The last increasing allocation uses `maxUint256` to absorb rounding dust. The keeper validates that the total withdrawn equals the total supplied before submitting.
    * The `reallocate()` call on the Euler Earn contract atomically redistributes capital across all strategies according to the new allocations.

    **Ark keeper:**
    
    * If the Buffer is in deficit and below target, the keeper withdraws from out-of-range buckets into the Buffer until the deficit is closed. For each candidate bucket, if `bucket === optimalBucket` or `lpToValue(bucket) < minMoveAmount` or `isBucketInRange(bucket, data) === true`, it skips. Otherwise it calls `vault.moveToBuffer(from=bucket, amount=min(lpToValue(bucket), remainingDeficit))`.
    * If the Buffer is not in deficit (i.e. at target), the keeper consolidates out-of-range buckets. For each bucket where `!isBucketInRange(...)`, if it is not the `optimalBucket` and `lpToValue(bucket) >= minMoveAmount`, call `vault.move(from=bucket, to=optimalBucket, amount=lpToValue(bucket))`, otherwise skip.
    * After covering deficits or consolidating, the keeper re-checks Buffer vs. target:
      * If there is a surplus in the Buffer, the keeper transfers the excess from the Buffer into the optimal bucket via `vault.moveFromBuffer(to=optimalBucket, amount=bufferTotal - bufferTarget)`.
      * If the buffer is still in deficit, the keeper continues pulling liquidity from out-of-range buckets into the Buffer with `vault.moveToBuffer(...)` until the gap is closed or no suitable buckets remain.
    * Guards per move (reads before each tx)
      * `shouldSkipBucket(bucket, data)` - returns `true` if the bucket is the `optimalBucket`, if `lpToValue(bucket) < minMoveAmount` (dust), or if `isBucketInRange(bucket, data)` is `true`. Otherwise, the bucket is a candidate for moves.
      * `isBucketInRange(bucketPrice, data)` - returns `true` if the bucket's price lies within `[max(LUP, priceAt(minBucketIndex)), min(currentPrice, HTP)]`. Buckets outside this range are considered out-of-range and eligible for rebalancing.

6. Housekeeping & Telemetry:
    * Vault events & functions:
      * `Move(fromBucket, toBucket, amount)` - vault function and event that shifts liquidity directly between buckets. The keeper uses it when consolidating out-of-range buckets into the `optimalBucket` without touching the Buffer.
      * `MoveFromBuffer(toBucket, amount)` - vault function and event that moves liquidity out of the Buffer into a bucket. The keeper calls this to drain Buffer surplus or to place funds into the `optimalBucket`.
      * `MoveToBuffer(fromBucket, amount)` - vault function and event that withdraws liquidity from a bucket into the Buffer. The keeper uses it to top up the Buffer or cover a deficit.
    * Logs (pino-formatted JSON, filterable by event field):
      * Info events:
          * `ark_run_complete` - final state for an ark run with buffer total, buffer target, current price, and optimal bucket.
          * `metavault_run_complete` - metavault reallocation completed with final allocations.
          * `no_metavault_reallocation_needed` - metavault run determined no reallocation is needed.
          * `paused_arks_detected` - one or more arks are paused, metavault run skipped.
          * `keeper_stopping` - process shutdown (SIGINT/SIGTERM).
          * `keeper_price_fixed` - keeper is bypassing price fetch and using the value defined in the config.
          * `tx_success` - successful tx with hash, block, action (`move`, `moveToBuffer`, `moveFromBuffer`, `drain`, `reallocate`), amount, and from/to buckets.
      * Warnings:
          * `ark_run_halted` - emitted when the ark keeper is halted due to a `LUPBelowHTP` error. The keeper will not run again until the process is restarted.
          * `subgraph_fail_open_enabled` - emitted at startup when `keeper.exitOnSubgraphFailure` is set to `false`, meaning subgraph query failures will be treated as if there are no auctions.
          * `oracle_staleness_check_disabled` - emitted at startup when the Chronicle stale-price check has been explicitly disabled with `oracle.onchainMaxStaleness: null`.
          * `oracle_fixed_price_enabled` - emitted at startup when `oracle.fixedPrice` is configured and the keeper will bypass live oracle reads.
          * `price_query_failed` - query failed for the first of the two configured price feeds.
          * `gas_estimation_failed` - Viem gas estimation for vault functions failed, indicating that the keeper will fall back to the hard-coded value.
      * Errors:
          * `ark_run_aborted` - emitted when an ark keeper run exits early for any of the reasons specified above in [Early Fail or Skip Conditions](#exit-conditions).
          * `metavault_run_aborted` - metavault run aborted with the reason.
          * `keeper_run_failed` - run aborted with error details (scheduler-level catch).
          * `tx_failed` - failed tx with phase (`send`, `fail`, `revert`, `insufficient_funds`), hash, receipt, and context.
          * `subgraph_query_failed` - query for open auctions via configured subgraph threw an error.
      * Fatal:
          * `uncaught_exception` - an unhandled error crashed the keeper process.
          * `unhandled_rejection` - an unhandled promise rejection crashed the keeper process.

## Local Set Up

#### Install dependencies:

```
pnpm install --frozen-lockfile --ignore-scripts
```

#### Install submodules:

```
git submodule update --init --recursive
```

#### Build:

```
pnpm build
```

#### Import a private key to a keystore (local mode):

As an alternative to defining `PRIVATE_KEY` directly in `.env`, a private key can be encrypted into an Ethereum V3 keystore file. This avoids storing the raw key on disk for local environments. To import:

```
pnpm import-key
```

This will prompt for the private key and a password, then write the encrypted keystore file. Set `KEYSTORE_PATH` in `.env` to the path of the generated file. On startup, the keeper will prompt for the password to decrypt it.

#### Docker:

If using Docker, the above steps can be skipped. Instead, build locally with:

```
pnpm docker:build:local
```

Or build for production using:

```
pnpm docker:build:prod
```

Note that local builds inject `.env`, while production builds expect environment variables to be provided at runtime.

After building, run the keeper locally with:

```
pnpm docker:run:local
```

There is no default script for using Docker to run the keeper in production, since this is likely to be environment-specific.

## Configure Environment

Configuration is split between `.env` (secrets and infrastructure) and `config.json` (operational parameters).

For `.env`, define the required secrets:

```
cp .env.example .env
```

Then replace the placeholder values in `.env`. At minimum, `RPC_URL`, `SUBGRAPH_URL`, and exactly one credential mode must be set:

- `PRIVATE_KEY`
- `KEYSTORE_PATH`
- `REMOTE_SIGNER_URL` with `REMOTE_SIGNER_ADDRESS`

For `config.json`, start from the example:

```
cp config.example.json config.json
```

Then fill in the required values. At minimum, `quoteTokenAddress`, `arks`, `buffer`, and oracle configuration must be set. If the metavault address is provided, the metavault keeper will run alongside the ark keeper. If omitted, only the ark keeper runs.

In production, `.env` values should be provided at runtime from the deployment environment. Prefer a remote signer when available. If you use a raw private key instead, inject it from the deployer's secret manager rather than baking it into images or committed files. The `config.json` file should be mounted or baked into the container.

## Run Tests

First, complete the above steps for local configuration and set up. Then, install `foundryup`:

```
curl -L https://foundry.paradigm.xyz | bash
```

After following the instructions that will appear from `foundryup`, install the vault's submodules:

```
cd lib/4626-ajna-vault/
forge install
```

Then (after navigating back to the root of the keeper repo) run the tests:

```
pnpm test
```
