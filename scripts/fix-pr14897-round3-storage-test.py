from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}")
    file.write_text(text.replace(old, new, 1))


path = "src/platform/workflow/persistence/migration/migrateV1toV2.test.ts"

replace_once(
    path,
    """  constructor(
    source: Storage,
    private readonly writeError: (key: string, value: string) => Error | null
  ) {
""",
    """  constructor(
    source: Storage,
    private readonly writeError: (key: string, value: string) => Error | null,
    private readonly readError: (key: string) => Error | null = () => null
  ) {
""",
)

replace_once(
    path,
    """  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
""",
    """  getItem(key: string): string | null {
    const error = this.readError(key)
    if (error) throw error
    return this.values.get(key) ?? null
  }
""",
)

replace_once(
    path,
    """function installFaultStorage(
  writeError: (key: string, value: string) => Error | null
): () => void {
  const original = globalThis.localStorage
  const faultStorage = new FaultInjectingStorage(original, writeError)
""",
    """function installFaultStorage(
  writeError: (key: string, value: string) => Error | null,
  readError: (key: string) => Error | null = () => null
): () => void {
  const original = globalThis.localStorage
  const faultStorage = new FaultInjectingStorage(original, writeError, readError)
""",
)

replace_once(
    path,
    """    it('degrades safely when localStorage reads are blocked', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('Storage blocked', 'SecurityError')
      })

      expect(migrateV1toV2(personalWorkspace)).toBe(-1)
      expect(isV2MigrationComplete(personalWorkspace)).toBe(false)
      expect(getMigrationStatus(personalWorkspace)).toEqual({
        v1Exists: false,
        v2Exists: false,
        v1DraftCount: 0,
        v2DraftCount: 0
      })
    })
""",
    """    it('degrades safely when localStorage reads are blocked', () => {
      const restoreStorage = installFaultStorage(
        () => null,
        () => new DOMException('Storage blocked', 'SecurityError')
      )

      try {
        expect(migrateV1toV2(personalWorkspace)).toBe(-1)
        expect(isV2MigrationComplete(personalWorkspace)).toBe(false)
        expect(getMigrationStatus(personalWorkspace)).toEqual({
          v1Exists: false,
          v2Exists: false,
          v1DraftCount: 0,
          v2DraftCount: 0
        })
      } finally {
        restoreStorage()
      }
    })
""",
)
