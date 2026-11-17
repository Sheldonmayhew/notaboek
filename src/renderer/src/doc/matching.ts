// Finds which original block each current block came from, or -1 for a new or
// edited one. Runs of unchanged blocks at either end match by position, so
// identical paragraphs keep their own source around an edit.
export function matchOrigins(keys: string[], blocks: ReadonlyArray<{ key: string }>): number[] {
  const origins = keys.map(() => -1)
  let start = 0
  while (start < keys.length && start < blocks.length && keys[start] === blocks[start].key) {
    origins[start] = start
    start++
  }

  let end = 0
  while (
    end < keys.length - start &&
    end < blocks.length - start &&
    keys[keys.length - 1 - end] === blocks[blocks.length - 1 - end].key
  ) {
    origins[keys.length - 1 - end] = blocks.length - 1 - end
    end++
  }

  const available = new Map<string, number[]>()
  for (let index = start; index < blocks.length - end; index++) {
    const list = available.get(blocks[index].key)
    if (list) list.push(index)
    else available.set(blocks[index].key, [index])
  }

  for (let index = start; index < keys.length - end; index++) {
    const origin = available.get(keys[index])?.shift()
    if (origin !== undefined) origins[index] = origin
  }
  return origins
}
