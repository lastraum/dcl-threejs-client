# DCL Foundation: Polygon P2P trade settle vs inventory index lag

**Date:** 2026-08-07  
**Context:** In-client P2P wearable trades settled via official **DecentralandMarketplacePolygon** (`accept` + meta-tx).  
**Ask:** Help identify why **marketplace-api** / Catalyst backpack lag (or miss) ownership updates that **chain** and **collections-matic-mainnet** already have.

---

## Summary for Foundation

We settle **official** off-chain marketplace **Asset Swaps** on Polygon:

1. Party A EIP-712 signs a `Trade`
2. Party B calls `accept([trade])` via **`executeMetaTransaction`** on the marketplace

On-chain this emits normal **ERC-721 `Transfer`** (plus marketplace **`Traded`** and **`MetaTransactionExecuted`**).

| Layer | Status after example settle (~30–60+ min) |
|--------|-------------------------------------------|
| Polygon `ownerOf` | Correct |
| OpenSea | Correct |
| Polygonscan ERC-721 transfers | Correct |
| `collections-matic-mainnet` subgraph | Correct + head live |
| `marketplace-api.decentraland.org` `/v1/nfts` | **Still old `owner`** |
| Catalyst `/lambdas/users/{addr}/wearables` | **Often still stale** |

**Hypothesis:** collections ownership indexing is fine; **nft-server / marketplace-api (and Catalyst inventory)** do not refresh owner promptly for **P2P `accept` / `Traded`** paths (no Order / no Sale), especially when `accept` is meta-tx’d. We may be among the first heavy in-client users of pure Asset Swap + meta-tx settle.

---

## Our marketplace contract path (exact)

| Item | Value |
|------|--------|
| Contract name | `DecentralandMarketplacePolygon` |
| Address | `0x540fb08eDb56AaE562864B390542C97F562825BA` |
| Chain | Polygon mainnet (`137`) |
| EIP-712 domain | name `DecentralandMarketplacePolygon`, version `1.0.0` |
| Model | [decentraland/offchain-marketplace-contract](https://github.com/decentraland/offchain-marketplace-contract) — **Trades / Asset Swaps** |
| Sign | EIP-712 `Trade` (signer = inviter) |
| Settle | `accept(Trade[])` as **functionData** inside meta-tx |
| Meta-tx entry | `executeMetaTransaction(address user, bytes functionData, bytes signature)` — selector **`0xd8ed1acc`** |
| Assets | ERC-721 Collection V2 (`assetType = 3`), optional ERC-20 MANA (`assetType = 1`) |
| Approvals | Collection `setApprovalForAll(marketplace, true)` (meta-tx when needed) |
| Beneficiaries | Explicit peer wallet on each asset (no longer left as `0x0` only) |

Polygon marketplace supports meta-transactions per contract docs; Asset Swaps are a documented trade shape.

---

## Events emitted on a successful settle

From production example tx  
https://polygonscan.com/tx/0x4de044b61fd7970e9cfc283300ee8d3be0f10221d0c53a253bc8bfd70ec4980b

| Order | Contract | Event | Topic0 (prefix) |
|------:|----------|--------|-----------------|
| 1 | Marketplace `0x540f…` | **MetaTransactionExecuted** | `0x58458921…` |
| 2 | NFT collection | **Approval** | `0x8c5be1e5…` |
| 3 | NFT collection | **Transfer** | `0xddf252ad…` |
| 4 | NFT collection | **Approval** | `0x8c5be1e5…` |
| 5 | NFT collection | **Transfer** | `0xddf252ad…` |
| 6 | Marketplace `0x540f…` | **Traded** | `0xaaecdfa7…` |
| 7 | POL system | fee log | — |

**Ownership moves only via collection `Transfer`.** OpenSea indexes that; explorers show it immediately.

Parties on that tx:

- Meta-tx user (acceptor): `0xAaBe0ecFaf9e028d63cf7ea7E772CF52d662691A` (Lastraum)
- Trade signer (inviter): `0x1E93E534C5E26B01Ed242410b43AE23dD0fAA52b` (ile)

Tokens:

| Collection | Token ID | On-chain after settle |
|------------|----------|------------------------|
| `0xbaa24df74ebd721da500863fd7f8b4d9fcd8c574` | `105312291668557186697918027683670432318895095400549111254310977919` | → Lastraum |
| `0xc7bb550b971418d58922ebcd53e22a4039f6d325` | `270` | → ile |

---

## What we verified (indexes)

### Official subgraph worker

`GET https://subgraph.decentraland.org/` lists (among others):

- `collections-matic-mainnet` ← **Polygon wearables ownership**
- `marketplace` ← Ethereum LAND-oriented (not the right head for these wearables)

Per [ADR-170](https://github.com/decentraland/adr/blob/main/content/ADR-170-subgraph-cloudflare-worker.md), apps query:

```text
POST https://subgraph.decentraland.org/collections-matic-mainnet
```

nft-server defaults historically pointed at `collections-matic-mainnet` for Polygon collections (see `decentraland/nft-server` `.env.defaults`).

### Probe results (example ~50 min after settle)

**Chain**

- Walkman `ownerOf` = Lastraum ✓  
- AngZaar `#270` `ownerOf` = ile ✓  

**Collections subgraph** (`collections-matic-mainnet`)

- Head lag ~ tens of blocks (live)  
- `hasIndexingErrors: false`  
- `nft.owner` matches chain ✓  
- `transferredAt` = settle time ✓  
- Related `sales` for those NFT ids: **empty** (no Sale entity for this P2P swap)

**marketplace-api**

```text
GET https://marketplace-api.decentraland.org/v1/nfts?contractAddress={c}&tokenId={tid}
```

- Walkman `owner` still ile ✗  
- AngZaar `#270` `owner` still Lastraum ✗  
- `updatedAt` not advanced to settle time  

**Catalyst**

```text
GET https://peer.decentraland.org/lambdas/users/{addr}/wearables
```

- Inventory still inconsistent with `ownerOf` (sender/recipient lists lag)

---

## How to re-check (copy/paste)

### Subgraph head + NFT owner

```bash
# Head
curl -s https://subgraph.decentraland.org/collections-matic-mainnet \
  -H 'content-type: application/json' \
  -d '{"query":"{ _meta { block { number timestamp } hasIndexingErrors } }"}'

# NFT id = lowercase(contract) + "-" + decimal tokenId
curl -s https://subgraph.decentraland.org/collections-matic-mainnet \
  -H 'content-type: application/json' \
  -d '{"query":"{ nft(id:\"0xbaa24df74ebd721da500863fd7f8b4d9fcd8c574-105312291668557186697918027683670432318895095400549111254310977919\") { owner { id } transferredAt } }"}'
```

### marketplace-api

```bash
curl -s "https://marketplace-api.decentraland.org/v1/nfts?contractAddress=0xbaa24df74ebd721da500863fd7f8b4d9fcd8c574&tokenId=105312291668557186697918027683670432318895095400549111254310977919" \
  | jq '.data[0].nft | {owner, updatedAt, name}'
```

### Compare matrix

| Check | Correct means |
|--------|----------------|
| `ownerOf` | Chain OK |
| collections SG `nft.owner` | Ownership subgraph OK |
| collections SG lag ~0 | Indexer head OK |
| marketplace-api `owner` wrong | **API / product index gap** |
| Catalyst wearables wrong | **Inventory lag** |

---

## Comparison: gift / OpenSea / our settle

| Flow | On-chain | What feels “fast” |
|------|----------|-------------------|
| **DCL gift/transfer UI** | Direct `collection.transferFrom` → `Transfer` | Marketplace **client** optimistically updates after its own tx (`transferNFTSuccess`); does not wait on cold API for the sender UX |
| **OpenSea transfer** | `Transfer` | OpenSea’s indexer + UI |
| **Our P2P settle** | Marketplace `accept` (meta-tx) → still collection `Transfer` + **`Traded`** | OpenSea/Polyscan fast; **DCL backpack / marketplace-api** slow if they re-query indexes |

Collections subgraph treats **ownership via `Transfer`** for all of the above.  
marketplace-api can lag for **any** path that does not bust order/sale caches — gift and our swap are both “no Order / often no Sale,” so API lag is not unique to us; gift **UI** just hides it with local success handling.

---

## Questions for Foundation

1. For Polygon wearables, what is the **source of truth** for:
   - Explorer backpack  
   - `marketplace-api` `/v1/nfts` `owner` field  
   (collections subgraph only? secondary DB/cache? other?)

2. Does that pipeline subscribe to:
   - collection **`Transfer`**, and/or  
   - marketplace **`Traded`** (`topic0` `0xaaecdfa7…`) on `0x540fb08eDb56AaE562864B390542C97F562825BA`?

3. Why can **`collections-matic-mainnet`** show the correct `owner` while **`marketplace-api`** still returns the previous `owner` for the same `contractAddress` + `tokenId` for 30–60+ minutes?

4. Do **P2P Asset Swaps** (`accept` with sent/received ERC-721s, no prior Order) intentionally **not** create `Sale` and/or **not** invalidate marketplace-api owner cache?

5. Does **meta-tx** (`executeMetaTransaction`, `tx.from` = relayer, user in event) affect owner refresh if anything keys off `tx.from` instead of `Transfer` parties?

6. Please reindex or fix owner updates for sample:

   - Tx: `0x4de044b61fd7970e9cfc283300ee8d3be0f10221d0c53a253bc8bfd70ec4980b`  
   - `0xbaa24df7…c574` / tokenId `…77919` → should be `0xaabe0ecf…691a`  
   - `0xc7bb550b…d325` / tokenId `270` → should be `0x1e93e534…a52b`

---

## One-liner

> We settle **DecentralandMarketplacePolygon** (`0x540f…`) with EIP-712 **Trade** + meta-tx **`accept`**. Chain emits ERC-721 **`Transfer`** + marketplace **`Traded`**. OpenSea and **collections-matic-mainnet** match chain; **marketplace-api + Catalyst backpack stay on old owners**. Please check **API/owner cache invalidation for P2P `Traded` / Transfer** (no Order), not missing chain events.

---

## Contact / product context

- Client: Last Slice / ThreejsClient in-world P2P trade  
- Contract integration follows official off-chain marketplace Asset Swap + Polygon meta-tx  
- We already mitigate UX with on-chain `ownerOf` / post-settle inventory seed; DCL Explorer and marketplace-api still mislead users until indexes catch up  
