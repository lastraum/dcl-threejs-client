/** Browser stub — protobufjs probes `fs.readFile`; Vite's externalized `fs` throws on access. */
const emptyFs = {
  readFile: undefined,
  readFileSync: undefined
}

export default emptyFs
export const readFile = undefined
export const readFileSync = undefined
