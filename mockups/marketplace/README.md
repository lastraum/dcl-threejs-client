# Marketplace UI mockups

Concept art for a **built-in DCL NFT marketplace** inside ThreejsClient — not the flat marketplace.decentraland.org experience.

Generated with xAI Imagine (Grok). Treat labels/prices as mood, not pixel-perfect specs.

## Product shape (agreed direction)

| Surface | Chrome | Job |
| --- | --- | --- |
| **Marketplace (v1)** | Full page (2D) + Events-scale glass overlay (3D) | Full catalog: Discover + Wearables / Emotes / Names / Land |
| **Quick Shop (later)** | Side panel | Reuse shared cards; e.g. “Shop this scene” |

**Build order:** full Market first → shared components (item model, selection, filters, result arrays) → later reuse in Quick Shop / scene shop.

## Placement in the product

| Surface | Entry | Status today |
| --- | --- | --- |
| **2D shell** | New top-nav tab **Market** | Not wired (`SocialShellTab` has no `market` yet) |
| **3D HUD** | Sidebar **Marketplace** (bag icon) | Stub in `ClientShell` — opens full Market overlay when built |

Shop the four DCL NFT classes:

1. **Wearables** — 3D try-on, rarity rims, equip from HUD  
2. **Emotes** — motion-preview cards, play-on-hover  
3. **Names** — claim / trade / auction, big type  
4. **Land** — map-first browse + parcel detail  

## Files

### Core / earlier passes

| File | Concept |
| --- | --- |
| `01-2d-home-discover.jpg` | Full 2D shell Market home — hero drop stage, category chips, trending rail |
| `01b-2d-home-alt.jpg` | Alternate 2D home composition |
| `02-3d-hud-overlay.jpg` | Early in-world panel concept (v1 is full overlay instead; keep for Quick Shop later) |
| `03-wearable-detail-tryon.jpg` | Item detail + 360° avatar runway / Buy + Make Offer |
| `04-emotes-category.jpg` | Emotes browse — motion silhouettes, play previews |
| `05-names-category.jpg` | Names market — holographic name, live auctions |
| `06-land-map-shop.jpg` | Land market — map-first + parcel side panel |
| `07-unified-discovery-feed.jpg` | Cross-type mixed feed (“Vibe Market”) |
| `08-mobile-hot-drops-sheet.jpg` | Mobile / quick sheet energy (later Quick Shop) |

### Discover set (full Market v1 — component goldmine)

| File | Concept | Shared pieces to extract |
| --- | --- | --- |
| `09-discover-home-rails.jpg` | Discover home: hero limited drop + rails (Trending / New / Friends / Creator) | `HeroDrop`, `RailSection`, `ItemCard`, top Market tabs |
| `10-discover-for-you-feed.jpg` | For You masonry — mixed Wearable / Emote / Name / Land cards | Polymorphic `MarketItem` card shapes, social proof chips, credits + MANA strip |
| `11-discover-hot-drops.jpg` | Hot Drops stage: countdown, claim progress, upcoming list, Just Dropped grid | `DropTimer`, `ClaimProgress`, `UpcomingList`, `ItemCard` grid |
| `12-discover-trending-leaderboard.jpg` | Ranked trending list + spotlight panel | `CategoryFilter`, `RankedRow`, `Sparkline`, `SelectedSpotlight` |
| `13-discover-search-filters-selected.jpg` | Search + filters + multi-select action bar | `FilterSidebar`, `FilterChips`, `sort`, `selectedIds[]`, bulk bar |
| `14-discover-selected-item-drawer.jpg` | Grid + selected item detail drawer | `selectedItem`, detail drawer, Try On / Buy / Offer |

## Shared component sketch (v1)

Implement against Discover first; category pages and Quick Shop reuse the same core:

```
MarketItem          // urn, type, name, rarity, priceMana, thumb, creator, …
MarketItemCard      // wearable | emote | name | land variants
MarketFilters       // category, rarity, price, query, sort
filterMarketItems() // pure: items + filters → filtered[]
MarketSelection     // selectedIds / selectedItem
HeroDrop / RailSection / DropTimer / DetailDrawer
```

## Design direction (vs stock DCL market)

**Kill the spreadsheet energy.** Boutique + item shop:

- **Material:** dark glass, soft bloom, magenta `#FF2D55` + purple/cyan  
- **Depth:** pedestals, volumetric hero lights, rarity glow borders  
- **Play:** try-on (backpack preview), emote play, land Visit  
- **Social proof:** friends own / friends wearing / live claim counts  
- **Wallet chrome:** MANA + Marketplace Credits bag  
- **Discovery first:** rails, For You, Hot Drops, trending — not page 1 of 9000  

## Implementation notes (when we build)

- **2D:** `SocialShellTab` + top nav `market`; page view peer of `LootBagPageView`.  
- **3D:** full Events-scale overlay (not small HUD) from bag icon; replace stub.  
- **Data:** marketplace-api / catalyst over raw subgraph where possible; cache; progressive load.  
- **Try-on:** backpack equip + `AvatarPreviewMini`.  
- **Credits:** “Go Shopping” → this Market, not external URL.  
- **Later:** Quick Shop side panel reuses `MarketItemCard` + filters subset (“Shop this scene”).

## Working name

Nav: **Market**. Discover sub-views as above. Playful marks in mockups (“Vibe Market”) optional.
