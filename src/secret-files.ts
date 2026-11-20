// Files Benny must never read or talk about (requirements 49-51). Templates such as
// `.env.example` stay readable, because they hold names, not values.
const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist']

const SECRET_NAMES = [
    /^\.env$/,
    /^\.env\..+$/,
    /^\.dev\.vars$/,
    /^\.dev\.vars\..+$/,
    /^\.npmrc$/,
    /^\.netrc$/,
    /^\.pgpass$/,
    /^id_(rsa|dsa|ecdsa|ed25519)$/,
    /\.(pem|key|p12|pfx|keystore|jks)$/,
    /^credentials(\.json)?$/,
    /^service-account.*\.json$/,
]

/** True when a path names a secret file. Works on any path form: `/repo/.env`, `repo/a/.env.local`, `.env`. */
export const isSecretPath = (path: string) => {
    const fileName = path.split('/').filter(Boolean).at(-1) ?? ''
    if (TEMPLATE_SUFFIXES.some((suffix) => fileName.endsWith(suffix))) return false
    return SECRET_NAMES.some((pattern) => pattern.test(fileName))
}
