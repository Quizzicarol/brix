// Temporary script to check wallet config
process.chdir('/app/server');
const w = require('./services/wallet');
console.log('enabled:', w.isEnabled());
console.log('mode:', w.getMode());
console.log('provider:', process.env.WALLET_PROVIDER);
console.log('has_mnemonic:', !!process.env.SPARK_MNEMONIC);
console.log('has_apikey:', !!process.env.BREEZ_API_KEY);
