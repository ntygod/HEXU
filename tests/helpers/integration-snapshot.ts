import {
  objectHash,
  verifySnapshot,
  type SnapshotObject,
} from '../../apps/runner/src/agent/checkpoint-objects.js';
export type Format = 'sha1' | 'sha256';
export type Value = string | Buffer | { data: string | Buffer; mode: string };
export interface Item {
  name: string | Buffer;
  children?: Item[];
  mode?: string;
  data?: Buffer;
}
export async function itemsSnapshot(items: Item[], format: Format = 'sha1') {
  const objects = new Map<string, SnapshotObject>();
  const put = (type: SnapshotObject['type'], data: Buffer) => {
    const id = objectHash(format, type, data);
    objects.set(id, { id, type, data });
    return id;
  };
  const makeTree = (children: Item[]): string =>
    put(
      'tree',
      Buffer.concat(
        children.map((item) => {
          const mode = item.mode ?? (item.children ? '40000' : '100644');
          const id = item.children
            ? makeTree(item.children)
            : mode === '160000'
              ? 'a'.repeat(format === 'sha1' ? 40 : 64)
              : put('blob', item.data ?? Buffer.alloc(0));
          return Buffer.concat([
            Buffer.from(`${mode} `),
            Buffer.from(item.name),
            Buffer.from([0]),
            Buffer.from(id, 'hex'),
          ]);
        }),
      ),
    );
  const tree = makeTree(items),
    commit = put('commit', Buffer.from(`tree ${tree}\n\ntrial fixture\n`));
  return {
    tree,
    commit,
    ...(await verifySnapshot(format, commit, tree, async (id) => objects.get(id)!.data)),
  };
}
export async function snapshot(files: Record<string, Value>, format: Format = 'sha1') {
  const root: Item[] = [];
  for (const [path, value] of Object.entries(files)) {
    const parts = path.split('/');
    let children = root;
    for (const name of parts.slice(0, -1)) {
      let item = children.find((i) => i.name === name);
      if (!item) {
        item = { name, children: [] };
        children.push(item);
      }
      children = item.children!;
    }
    const file = typeof value === 'string' || Buffer.isBuffer(value) ? { data: value } : value;
    children.push({
      name: parts.at(-1)!,
      data: Buffer.from(file.data),
      mode: 'mode' in file ? file.mode : undefined,
    });
  }
  return itemsSnapshot(root, format);
}
