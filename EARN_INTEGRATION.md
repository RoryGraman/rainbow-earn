# Quicknode Earn in Rainbow (demo)

This branch (`earn`) adds an **Earn** page to the Rainbow extension popup. The **Earn** button in the wallet header, next to **Buy**, opens it, and the X closes it. A user can deposit USDC into the five largest Morpho vaults on Base through the Quicknode Earn API, see the position, and withdraw. No fee wrappers or custom contracts are involved.

## User flow

Nothing is signed or sent until you approve that exact action on its own screen. Rainbow signs messages from inside the wallet with no screen of its own, so every signature the Earn flow needs stops at `EarnConfirmSheet` first. The flow code cannot sign without it: `askUser` is the only way to get the proof (`Grant`) that `signWithGrant` and `sendWithGrant` require.

**New deposit**

1. Press **Earn** in the wallet header. Enter a USDC amount (at least 500). The five vaults that the server picks for that amount are listed.
2. Press **Sign and start earning**.
3. **Sign to accept the terms.** The sheet shows the exact SIWE message (`strategy.create`) and a terms link. Approve to sign. This creates the strategy.
4. **Approve tokens.** The sheet lists USDC (your exact amount) and each vault's share token (no limit), with the spender contract. Approve to send up to 6 approval transactions.
5. **Deposit.** The sheet shows the amount, the contract, and the split across the vaults. Approve to send the deposit.
6. The screen waits until the strategy is `active`.

**Open strategy screen** (no vault list)

- Value, **current yield** (the server's cumulative yield, or value minus deposited before the first hourly snapshot), **APY**, and deposited amount.
- **Increase deposit** (minimum 10 USDC, up to your wallet balance). Adds USDC to the vaults the strategy already holds. Approvals (if USDC needs one) and the deposit each have a sheet.
- **Decrease deposit.** Reads the server's limits (minimum, maximum, fee) first. A sheet shows what leaves, the fee, and what you receive.
- **Close strategy.** Withdraws everything. If positions are paused, it warns first. It never signs `strategy.delete` for a funded strategy.
- **Settings.** Opens the advanced settings of the open strategy (rebalance gap, confirmations, min TVL, min liquidity, APY window). Saving signs one `strategy.update` message after you approve it. The number of vaults is fixed when the strategy is created.

Without an open strategy, the cogwheel at the top right of the Earn page edits the defaults for the next deposit and the production or staging switch.

## How the vaults are chosen

The deposit endpoint picks vaults itself. The code steers it with the strategy hide list (`hidden_vault_keys`):

1. Read `GET /v1/vaults?chains=8453&window=<APY window>` and the wallet's global hide list (`GET /v1/wallets/{addr}/prefs`). Drop the globally hidden vaults.
2. Keep vaults with a positive APY that pass the strategy's TVL and liquidity floors. These are the vaults the server counts as eligible.
3. Take the six largest of those that are not at capacity. The server rejects a hide list that drops the eligible count below `max_positions + 1` (409 `hide_floor_violated`), so six stay visible. When fewer than six are open, vaults at capacity fill the rest: the server counts them but never enters them.
4. Hide every other vault on the chain, except a vault listed at 0.00% APY. The list rounds APY to 2 decimals, and the server may count such a vault. It is not in the visible set, so a plan that uses it fails the plan check (`plan_mismatch`) and nothing is sent. The server uses such a vault only when fewer than `max_positions` open vaults have a positive APY and the vault holds a share approval from an earlier strategy.
5. Ask `GET /v1/vaults/rankings` with that hide list, the amount and the floors. It runs the server's own ranking: APY to 3 decimals, ties broken by vault key. Its top five are `selected`. They get the share approvals, and the sixth is the spare. Share approvals do not steer this: a wallet that used the Earn web app may have approved every vault already. If this read fails, the flow stops before any signature.
6. Before the deposit is sent, the plan must use only visible vaults. The review sheet lists the plan's own vaults and amounts.

The ranking is a preview. At deposit time the server checks capacity with a simulated deposit per vault, after the approvals. A vault that fails it drops out. The server then uses the spare only if it is approved, so the plan can hold fewer vaults than the screen showed. The review sheet shows the real split before the user signs.

## Minimum deposit

Base needs at least 500 USDC (`minStrategyUsdc` in `GET /v1/config`). The screen and the flow both enforce it.

## Why approvals come before the deposit calldata

Unapproved vault share tokens drop out of the API's vault ranking. So the approvals must be mined first. An EOA cannot batch them, so they are separate transactions.

## Code map

| Path | Purpose |
| --- | --- |
| `src/core/earn/siwe.ts` | SIWE message, canonical payload hash. Matches the Earn frontend byte for byte. |
| `src/core/earn/api.ts` | Typed client for the Earn `/v1` API and its error mapping. |
| `src/core/earn/vaults.ts` | Visible set (the N + 1 largest), hide list, server-ranked selection. |
| `src/core/earn/flow.ts` | `startStrategy` and `withdrawStrategy`. No wallet code. Everything is injected. |
| `src/core/earn/defaults.ts` | Environments, default settings, USDC constants. |
| `src/core/state/earn/` | Persisted settings store. |
| `src/entries/popup/pages/home/Earn/` | UI and the wallet adapter (`earnWallet.ts`). |
| `src/entries/popup/handlers/wallet.ts` | `sendTransaction` now keeps a caller-supplied gas limit and works without the fee screen. |
| `src/entries/popup/components/TransactionFee/TransactionFee.tsx` | Exports `Fee`, so the Earn reviews show Rainbow's own fee picker. |
| `static/allowlist.json` | Adds the Earn API hosts to the extension CSP `connect-src`. |

## Run it

```bash
corepack enable          # yarn 4.2.2
yarn install
yarn ds:generate-symbols && yarn patch-package
cp .env.example .env     # then add SECURE_WALLET_HASH_KEY=0x followed by 64 hex characters (the 0x is required)
yarn build
```

Open `chrome://extensions`, turn on Developer mode, and load the `build/` folder as an unpacked extension. Import a wallet that holds USDC on Base (and a little ETH for gas).

### Base RPC without Rainbow's keys

Rainbow reaches Base through its own RPC (`https://rpc.rainbow.me/v1/8453/` plus `RPC_PROXY_API_KEY`). Without Rainbow's key that fails, in the popup and in the background signer. So this fork adds an opt-in override:

- Set `EARN_BASE_RPC_URL` in `.env` to an https Base endpoint, for example your Quicknode one (`https://<name>.base-mainnet.quiknode.pro/<key>/`). `https://mainnet.base.org` also works, with rate limits.
- Only Base (chain 8453) is affected, and only when the variable is set. The code is `earnRpcOverride` in `src/core/earn/rpc.ts`, called from `handleRpcUrl` in `src/core/viem/clientRpc.ts`.
- The build adds the origin of `EARN_BASE_RPC_URL` to the extension CSP (`connect-src`) in `webpack.config.js`. With the variable unset, the manifest has no extra RPC host.
- If you have Rainbow's full `.env`, leave `EARN_BASE_RPC_URL` empty. Rainbow's own RPC is then used.

Other Rainbow backend calls (token balances, NFTs, remote config) also need Rainbow's keys. Without them the Tokens tab stays empty. Earn does not depend on them.

### `sendTransaction` change

`sendTransaction` in `src/entries/popup/handlers/wallet.ts` takes an optional second argument `{ useCallerGas: true }`. Only Earn sets it. It then keeps the gas limit and fees the caller passes, instead of re-estimating the gas limit and mixing in the fee screen's values. Without the option the code path is the same as upstream for every other caller (Send, dapp requests, speed up, revoke).

### Gas on the Earn reviews

Each Earn transaction review shows Rainbow's fee picker from its Send and Swap reviews: the estimated fee, the speed menu (Normal, Fast, Urgent, Custom), and the gas settings. The fee covers every transaction the review sends when each one has a gas estimate. On Base the L1 data fee counts once, as on Rainbow's own reviews. When the user approves, the fee of the picked speed applies to each transaction of that review. Earn sends it with `{ useCallerGas: true }`, so a fee saved by another Rainbow screen or chain never mixes in. The gas limit is Rainbow's padded estimate, never below the Earn API's hint. Each review clears Rainbow's saved custom fee when it opens and when it closes, as Rainbow's Send and Swap do. Rainbow prices the fee with the wallet's native asset from its asset service, in the wallet's currency. When that asset is missing (a build without Rainbow's API keys, or a wallet with no ETH on the chain), the Earn API's USD price (`/v1/prices`) stands in, but only when the wallet's currency is USD. The approve button waits up to 5 s for the fee of the picked speed. Without one, the send uses the network's current fee.

## Tests

```bash
yarn vitest run --config vitest.earn.config.ts   # Earn unit tests, no RPC keys needed
yarn typecheck
yarn eslint src/core/earn src/entries/popup/pages/home/Earn
```

The default `yarn test` config starts anvil forks and needs Rainbow's RPC proxy keys.

## Safety rules in the flow

- The deposit hash is saved before the flow waits for it. A resume waits for that receipt and never asks for new deposit calldata. Only a reverted deposit is sent again.
- A resumed deposit must match the amount of the unfinished strategy.
- Cancel and "Withdraw all" never sign `strategy.delete` for a funded strategy.
- If positions are paused, "Withdraw all" warns first. The server leaves paused positions out of a withdrawal.
- Run state lives in a store outside React, so leaving the Earn page cannot start a second run. Leaving the page declines an open review, and a review asked for while the page is closed is declined at once.
- A run signs only for the wallet it started with. A wallet switch declines an open review, and every signature and transaction checks the selected wallet just before it goes out (`wallet_switched`).
- Every approval is decoded from its calldata: `approve(spender, amount)` on the declared token, and a "USDC" item must be the USDC contract.
- Every deposit and increase is decoded from its calldata (`selfBatchDeposit`, ABI in `src/core/earn/abi.ts`). It must hold the plan's vaults and amounts in order, no bridge burns, the whole amount, and go to the approvals spender. Otherwise the flow stops before the review (`plan_mismatch`).
- A decrease without the server's fee quote stops before the review (`no_quote`).
- A settings review lists each changed setting as old value → new value. The signed message holds only a hash of the change.

## Known limits

- Base and USDC only. Cross-chain legs would need approvals on other chains, so they cannot join one flow.
- Approvals are separate transactions: USDC, then one per vault (up to 6), then the deposit. An EOA cannot batch them.
- The popup must stay open during a run. If it closes, reopen the Earn page and press **Resume deposit**.
- If the APYs move between the deposit screen and the deposit plan, the server can swap the spare in. The review sheet lists the plan's own vaults and amounts, so the user sees the real split before signing. The screen ranks for the typed amount once typing pauses; the flow ranks again when the user starts.
- The first live run on production is the first real signed write. The SIWE format is checked against the Earn frontend code and the documented hash, not against a live server write.
- The default `yarn test` config needs Rainbow's RPC proxy keys. Use `vitest.earn.config.ts` for the Earn tests.
