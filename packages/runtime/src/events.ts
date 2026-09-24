export class EventHub<T> {
  private readonly buffer: T[] = []
  private readonly waiters: Array<() => void> = []
  private ended = false

  emit(item: T): void {
    this.buffer.push(item)
    this.waiters.shift()?.()
  }

  end(): void {
    this.ended = true
    while (this.waiters.length > 0) this.waiters.shift()?.()
  }

  async *iterate(): AsyncGenerator<T> {
    let index = 0
    for (;;) {
      while (index < this.buffer.length) {
        yield this.buffer[index++] as T
      }
      if (this.ended) return
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
      })
    }
  }
}
