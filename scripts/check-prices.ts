import { SdexProvider, PegProvider, CompositeProvider } from '../src/pricing/providers.ts';
const p = new CompositeProvider([new PegProvider(), new SdexProvider()]);
const t = '2026-10-19T07:20:03Z';
for (const a of ['native', 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', 'BLND:GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY'])
  console.log(a.slice(0, 12), JSON.stringify(await p.price(a, t), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
