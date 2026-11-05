/** What Blend events exist on mainnet right now? Counts by contract + event name over the RPC retention window. */
import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { rpcCall } from '../src/sources/rpc.ts';
const dec = (b64: string) => scValToNative(xdr.ScVal.fromXDR(b64, 'base64'));
const CONTRACTS: Record<string, string> = {
  backstopV2: 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7',
  backstopV1: 'CAO3AGAMZVRMHITL36EJ2VZQWKYRPWMQAPDQD5YEOF3GIF7T44U4JAL3',
  factoryV2: 'CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU',
  FixedV2: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
  YieldBloxV2: 'CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS',
};
const latest = (await rpcCall('getLatestLedger', null)).sequence;
const start = latest - 120_000;
console.log('latest', latest, 'start', start);
const j = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
for (const [name, id] of Object.entries(CONTRACTS)) {
  const counts = new Map<string, number>();
  const sample = new Map<string, string>();
  let cursor: string | undefined;
  let total = 0;
  for (let page = 0; page < 6; page++) {
    const filters = [{ type: 'contract', contractIds: [id] }];
    const r: any = await rpcCall('getEvents', cursor ? { pagination: { cursor, limit: 200 }, filters } : { startLedger: start, pagination: { limit: 200 }, filters });
    for (const e of r.events) {
      const topics = e.topic.map((t: string) => dec(t));
      const n = String(topics[0]);
      counts.set(n, (counts.get(n) ?? 0) + 1);
      if (!sample.has(n)) sample.set(n, `${e.ledger} ${e.txHash.slice(0, 12)} ${j(topics).slice(0, 160)} ${j(dec(e.value)).slice(0, 160)}`);
    }
    total += r.events.length;
    cursor = r.cursor;
    if (r.events.length < 200) break;
  }
  console.log(`\n== ${name} ${id.slice(0, 8)} events=${total}${total >= 1200 ? '+' : ''}`);
  for (const [n, c] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${n.padEnd(22)} ${String(c).padStart(5)}  e.g. ${sample.get(n)}`);
}
