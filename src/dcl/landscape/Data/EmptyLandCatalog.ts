/** @dcl/asset-packs — category "empty land" + grass scatter props (Catalyst hashes). */
const TREE_01 = 'bafybeibpse7zmzxuge2l4vk3udmjyu6mzhvm62vmbjby65b6nlxg2v346y'
const TREE_02 = 'bafybeied5cx6vw6p7okstzk5d7fp7kpfujb2lfugte33l6euejajsiydo4'
const TREE_03 = 'bafybeig4v6vn4fdq62ri6ng5e3rd4m7pg4opicwr253t7hmsxxitepyb4y'

export const EMPTY_LAND = {
  ground: 'bafybeic34wsg4l2h7qioxndv7zlspscrinewlxqodvumx75bfrf3vvk3jq',
  trees: [TREE_01, TREE_02, TREE_03],
  /** Coral + pink canopies for padding scatter (skip teal tree03). */
  landscapeTrees: [TREE_01, TREE_02],
  bushes: [
    'bafybeif42vn5j7cw2q26wirrbe5lbgsv566yrjnuvf4gnn6f5wtv6zc62q',
    'bafybeiglwq7pipd2irqowprk7eiiptieavuiejsa5ptaxwdxowubt2d3ju'
  ],
  rocks: [
    'bafybeib6qtdlzenxu3ybnu46jertsgrd73evip3rsmdfrxvjdrly5qbqhu',
    'bafybeifg5x73vjufjrcy5ua5v7mxmcweefwteorboulj2njftgritdsysy',
    'bafybeihwqgqcmirv5zzz4ztokzeacqwyxsowhyoan2bjstjwwgrrsdscqa'
  ],
  /** Small grass clumps scattered on empty parcels (Explorer uses GPU grass; we use glTF patches). */
  grass: [
    'bafkreieufo3sbrampmvyhpwdsu546exejvc4xbdyxzglb6okt77ebtqxfa',
    'bafkreihx2kcslbpasprkgqgmzhajfghsfnmxutnzctiwlji6ab7uyowbf4',
    'bafkreihegdfhklvbchr2cbpfkpyq2gwm42oegysdd25fqa7uke4x7vpvnu',
    'bafkreifask5jhld5lxtdljy3xsfqlgrhm2gjkleshawbmzgmwns46m6is4'
  ]
} as const

export const CATALYST_CONTENTS = 'https://peer.decentraland.org/content/contents'

export function catalystAssetUrl(hash: string): string {
  return `${CATALYST_CONTENTS}/${encodeURIComponent(hash)}`
}

export function allLandscapeDecorationHashes(): string[] {
  return [
    EMPTY_LAND.ground,
    ...EMPTY_LAND.trees,
    ...EMPTY_LAND.bushes,
    ...EMPTY_LAND.rocks,
    ...EMPTY_LAND.grass
  ]
}
