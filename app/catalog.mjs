export const OWNER_POLICY = Object.freeze({
  allowedOfferIds: ['aster-extract', 'helio-extract', 'quill-extract', 'proofline-verify'],
  allowedChainIds: [84532, 1301],
  maxPerPurchase: 60,
  requiredService: 'invoice-extraction',
  maxEtaSeconds: 120,
  requirePrivate: true,
});

const CATALOG = Object.freeze([
  {id:'aster-extract', name:'Aster Extract', chain:'base', chainId:84532, amount:60,
    etaSeconds:45, privacy:'private', service:'invoice-extraction',
    description:'Private invoice extraction with a short delivery estimate.'},
  {id:'helio-extract', name:'Helio Extract', chain:'unichain', chainId:1301, amount:60,
    etaSeconds:20, privacy:'shared', service:'invoice-extraction',
    description:'Fast invoice extraction using shared processing.'},
  {id:'quill-extract', name:'Quill Extract', chain:'unichain', chainId:1301, amount:55,
    etaSeconds:90, privacy:'private', service:'invoice-extraction',
    description:'Lower-cost private invoice extraction with a longer delivery estimate.'},
  {id:'proofline-verify', name:'Proofline Verify', chain:'unichain', chainId:1301, amount:60,
    etaSeconds:30, privacy:'private', service:'invoice-verification',
    description:'Private validation of invoice fields and arithmetic.'},
]);

// Terms are supplied by the application, never by generated model text.
// All suppliers share a demonstration recipient, and no actual service is sold.
export function createCatalog(fixture) {
  return CATALOG.map(offer=>({
    ...offer, available:true, recipient:fixture.recipient,
    vault:fixture.chains[offer.chain].vault.target, demonstrationOnly:true,
  }));
}
