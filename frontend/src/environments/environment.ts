export const environment = {
  production: false,
  apiUrl: '/api',
  stellarNetwork: 'testnet' as const,
  stellarHorizonUrl: 'https://horizon-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  ipfsGateway: 'https://gateway.pinata.cloud/ipfs/',
  /**
   * Stellar public key of the protocol admin, i.e. the API's
   * `STELLAR_PUBLIC_KEY`. Set this per deployment — the value must be a real
   * `G…` account, never a placeholder (see issue #167).
   *
   * Leave it empty to disable every admin affordance in the UI. Any other
   * malformed value is rejected by `npm run check:env`, which runs before each
   * build.
   */
  adminAddress: '',
};
