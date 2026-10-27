import { describe, expect, it } from 'vitest'
import { inspect } from 'node:util'
import { MissingSecretsError, Secrets, unseal } from './secrets.js'

describe('Secrets', () => {
  const env = { A_PASS: 'hunter2-long', B_TOKEN: 'tok-9f2c1a', SHORT: 'ab' }

  it('seals exactly the requested names and reports short values', () => {
    const { secrets, short } = Secrets.fromEnv(['A_PASS', 'SHORT'], env)
    expect(secrets.names).toEqual(['A_PASS', 'SHORT'])
    expect(short).toEqual(['SHORT'])
  })

  it('throws once, naming every missing variable', () => {
    expect(() => Secrets.fromEnv(['A_PASS', 'NOPE', 'ALSO_NOPE'], env)).toThrow(MissingSecretsError)
    try {
      Secrets.fromEnv(['NOPE', 'ALSO_NOPE'], env)
    } catch (e) {
      expect((e as MissingSecretsError).missing).toEqual(['ALSO_NOPE', 'NOPE'])
    }
  })

  it('never prints values through string, JSON, or inspect', () => {
    const { secrets } = Secrets.fromEnv(['A_PASS'], env)
    for (const rendered of [String(secrets), `${secrets}`, JSON.stringify(secrets), inspect(secrets), JSON.stringify({ secrets })]) {
      expect(rendered).not.toContain('hunter2')
      expect(rendered).toContain('A_PASS')
    }
  })

  it('finds leaks and redacts values to their placeholder', () => {
    const { secrets } = Secrets.fromEnv(['A_PASS', 'B_TOKEN', 'SHORT'], env)
    expect(secrets.findLeak('await page.fill("x", "hunter2-long")')).toBe('A_PASS')
    expect(secrets.findLeak('nothing here')).toBeNull()
    expect(secrets.redact('got tok-9f2c1a and hunter2-long and ab')).toBe('got {{env.B_TOKEN}} and {{env.A_PASS}} and ab')
  })

  it('exposes values only through unseal', () => {
    const { secrets } = Secrets.fromEnv(['A_PASS'], env)
    expect(unseal(secrets)).toEqual({ A_PASS: 'hunter2-long' })
    expect(Object.keys(secrets)).toEqual([])
  })
})
