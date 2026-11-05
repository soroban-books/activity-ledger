/**
 * Blend pool verification. A contract is a Blend pool only if one of the Blend pool factories
 * deployed it. The factory records every pool in persistent storage under
 * `PoolFactoryDataKey::Contracts(pool) = true` (blend-contracts-v2 pool-factory/src/storage.rs),
 * which can be read with getLedgerEntries. Event shapes alone are not proof: any contract can
 * emit ["supply", asset, from].
 */
import { Address, xdr } from '@stellar/stellar-sdk';
import { rpcCall } from '../sources/rpc.ts';

export const BLEND_FACTORIES = [
  'CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU', // v2
  'CCZD6ESMOGMPWH2KRO4O7RGTAPGTUPFWFQBELQSS7ZUK63V3TZWETGAG', // v1
];

/** ScVal of `PoolFactoryDataKey::Contracts(pool)`: a contracttype enum is a Vec [Symbol(variant), ...fields]. */
export function factoryKey(factory: string, pool: string): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(factory).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Contracts'), new Address(pool).toScVal()]),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
}

/** true = a Blend factory deployed it; false = none did; throws if RPC is unreachable (caller must not cache that). */
export async function deployedByBlendFactory(pool: string): Promise<boolean> {
  const keys = BLEND_FACTORIES.map((f) => factoryKey(f, pool).toXDR('base64'));
  const r = await rpcCall<{ entries?: { xdr: string }[] | null }>('getLedgerEntries', { keys });
  return (r.entries ?? []).length > 0;
}
