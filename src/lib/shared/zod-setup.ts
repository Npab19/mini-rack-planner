// Must be imported before any module that builds zod schemas.
// jitless: zod 4 otherwise probes `new Function('')`, which a strict CSP (no 'unsafe-eval') reports as a violation.
import { z } from 'zod'

z.config({ jitless: true })
