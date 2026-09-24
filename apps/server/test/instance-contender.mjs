import { LachesisApplication } from '../src/application.ts'

try {
  const app = await LachesisApplication.open(process.argv[2])
  process.stdout.write('acquired\n')
  await app.close()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 42
}
