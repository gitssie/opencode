export function buildRuntimeText() {
  return {
    chunkMarkdownText(text: string, limit: number): string[] {
      if (text.length <= limit) return [text]
      const chunks: string[] = []
      let i = 0
      while (i < text.length) {
        chunks.push(text.slice(i, i + limit))
        i += limit
      }
      return chunks
    },
  }
}
