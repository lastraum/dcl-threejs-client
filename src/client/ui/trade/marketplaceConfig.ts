import type { Address, Hex } from 'viem'

/** Polygon — live DCL off-chain marketplace used by marketplace-api trades. */
export const MARKETPLACE_POLYGON = '0x540fb08eDb56AaE562864B390542C97F562825BA' as Address

/** Alternate / newer deploy (same contract family). Prefer primary above for signatures. */
export const MARKETPLACE_POLYGON_ALT = '0xa40b1d129b8906888720686f3a01921ddf37716f' as Address

/** Polygon MANA (bridged). */
export const POLYGON_MANA = '0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4' as Address

/** Ethereum mainnet MANA. */
export const ETHEREUM_MANA = '0x0f5d2fb29fb7d3cfee444a200298f468908cc942' as Address

export const POLYGON_CHAIN_ID = 137 as const
export const POLYGON_CHAIN_ID_HEX = '0x89' as const

/**
 * EIP-712 domain for DecentralandMarketplacePolygon.
 * Used for both Trade signatures and NativeMetaTransaction (meta-tx).
 */
export const MARKETPLACE_EIP712_NAME = 'DecentralandMarketplacePolygon'
export const MARKETPLACE_EIP712_VERSION = '1.0.0'

/** Meta-tx domain for marketplace accept / cancel (functionData field). */
export const MARKETPLACE_META_TX_DOMAIN = {
  name: MARKETPLACE_EIP712_NAME,
  version: MARKETPLACE_EIP712_VERSION
} as const

/**
 * Polygon MANA (PoS) NativeMetaTransaction domain.
 * @see decentraland-transactions manaToken MATIC_MAINNET
 */
export const POLYGON_MANA_META_TX_DOMAIN = {
  name: '(PoS) Decentraland MANA',
  version: '1'
} as const

/** Asset type enum from offchain-marketplace-contract. */
export const ASSET_TYPE = {
  ERC20: 1n,
  USD_PEGGED_MANA: 2n,
  ERC721: 3n,
  COLLECTION_ITEM: 4n
} as const

/** Zero bytes32 */
export const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

/** Trade signature lifetime after both UI-accept. */
export const SETTLE_TRADE_TTL_SEC = 30 * 60

/** Minimal ERC-20 / ERC-721 / marketplace fragments. */
export const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  }
] as const

export const erc721Abi = [
  {
    type: 'function',
    name: 'setApprovalForAll',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'isApprovedForAll',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'operator', type: 'address' }
    ],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'getApproved',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }]
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }]
  }
] as const

export const marketplaceAbi = [
  {
    type: 'function',
    name: 'accept',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: '_trades',
        type: 'tuple[]',
        components: [
          { name: 'signer', type: 'address' },
          { name: 'signature', type: 'bytes' },
          {
            name: 'checks',
            type: 'tuple',
            components: [
              { name: 'uses', type: 'uint256' },
              { name: 'expiration', type: 'uint256' },
              { name: 'effective', type: 'uint256' },
              { name: 'salt', type: 'bytes32' },
              { name: 'contractSignatureIndex', type: 'uint256' },
              { name: 'signerSignatureIndex', type: 'uint256' },
              { name: 'allowedRoot', type: 'bytes32' },
              { name: 'allowedProof', type: 'bytes32[]' },
              {
                name: 'externalChecks',
                type: 'tuple[]',
                components: [
                  { name: 'contractAddress', type: 'address' },
                  { name: 'selector', type: 'bytes4' },
                  { name: 'value', type: 'bytes' },
                  { name: 'required', type: 'bool' }
                ]
              }
            ]
          },
          {
            name: 'sent',
            type: 'tuple[]',
            components: [
              { name: 'assetType', type: 'uint256' },
              { name: 'contractAddress', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'beneficiary', type: 'address' },
              { name: 'extra', type: 'bytes' }
            ]
          },
          {
            name: 'received',
            type: 'tuple[]',
            components: [
              { name: 'assetType', type: 'uint256' },
              { name: 'contractAddress', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'beneficiary', type: 'address' },
              { name: 'extra', type: 'bytes' }
            ]
          }
        ]
      }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'contractSignatureIndex',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'signerSignatureIndex',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  }
] as const

/** EIP-712 types matching MarketplaceTypesHashing / official UI. */
export const TRADE_TYPED_TYPES = {
  Trade: [
    { name: 'checks', type: 'Checks' },
    { name: 'sent', type: 'AssetWithoutBeneficiary[]' },
    { name: 'received', type: 'Asset[]' }
  ],
  Asset: [
    { name: 'assetType', type: 'uint256' },
    { name: 'contractAddress', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'extra', type: 'bytes' },
    { name: 'beneficiary', type: 'address' }
  ],
  AssetWithoutBeneficiary: [
    { name: 'assetType', type: 'uint256' },
    { name: 'contractAddress', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'extra', type: 'bytes' }
  ],
  Checks: [
    { name: 'uses', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'effective', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
    { name: 'contractSignatureIndex', type: 'uint256' },
    { name: 'signerSignatureIndex', type: 'uint256' },
    { name: 'allowedRoot', type: 'bytes32' },
    { name: 'externalChecks', type: 'ExternalCheck[]' }
  ],
  ExternalCheck: [
    { name: 'contractAddress', type: 'address' },
    { name: 'selector', type: 'bytes4' },
    { name: 'value', type: 'bytes' },
    { name: 'required', type: 'bool' }
  ]
} as const

export function chainIdSalt(chainId: number): Hex {
  return `0x${chainId.toString(16).padStart(64, '0')}` as Hex
}
