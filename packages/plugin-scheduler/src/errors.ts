/** A rejected Lachesis operation, carrying the API error code and status. */
export class ApplicationError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}
