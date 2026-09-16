import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';

// Keys and signed tokens exist only in test-process memory, never snapshots or files.
//
// `alg` is a parameter because the API accepts RS256 and ES256, and a provider
// that signs with the one nobody tested is a production discovery.
export async function jwtFixture(alg='RS256'){
  const {privateKey,publicKey}=await generateKeyPair(alg);
  const key={...await exportJWK(publicKey),kid:`test-key-${alg}`,alg};
  const config={issuer:'https://issuer.example.invalid',audience:'leroutier-api-test',jwksUrl:'https://issuer.example.invalid/jwks'};
  const valid=(claims={})=>({sub:'fixture-subject',iss:config.issuer,aud:config.audience,
    iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600,...claims});
  return {config,resolver:createLocalJWKSet({keys:[key]}),publicKey:key,alg,
    sign:(subject,claims={},options={})=>new SignJWT(valid({sub:subject,...claims}))
      .setProtectedHeader({alg,kid:`test-key-${alg}`,...options}).sign(privateKey),
    // A symmetrically-signed token with otherwise perfect claims. Accepting
    // HS256 would let anyone holding the "public" key mint tokens, so the API
    // allows RS256 and ES256 only — and that has to be tested from outside.
    signSymmetric:(subject,claims={})=>new SignJWT(valid({sub:subject,...claims}))
      .setProtectedHeader({alg:'HS256'}).sign(new TextEncoder().encode('fixture-symmetric-key-32-bytes!!'))};
}
