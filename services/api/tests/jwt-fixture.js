import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';

// Keys and signed tokens exist only in test-process memory, never snapshots or files.
export async function jwtFixture(){
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const key={...await exportJWK(publicKey),kid:'test-key',alg:'RS256'};
  const config={issuer:'https://issuer.example.invalid',audience:'leroutier-api-test',jwksUrl:'https://issuer.example.invalid/jwks'};
  return {config,resolver:createLocalJWKSet({keys:[key]}),publicKey:key,
    sign:(subject,claims={},options={})=>new SignJWT({sub:subject,iss:config.issuer,aud:config.audience,
      iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600,...claims})
      .setProtectedHeader({alg:'RS256',kid:'test-key',...options}).sign(privateKey)};
}
