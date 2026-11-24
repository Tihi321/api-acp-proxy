/** The releases the Version list shows: the first `max` (newest first, as fetched) plus any later one whose tag is in `keep`; order kept. Pure. */
export function visibleReleases<T extends { tag: string }>(releases: readonly T[], keep: ReadonlyArray<string | undefined>, max = 5): T[] {
  return releases.filter((release, index) => index < max || keep.includes(release.tag));
}
