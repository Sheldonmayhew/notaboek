declare module 'commonmark-spec' {
  const spec: { tests: Array<{ markdown: string; html: string; section: string; number: number }> }
  export default spec
}
