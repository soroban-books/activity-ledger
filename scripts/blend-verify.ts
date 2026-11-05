/** Is this contract a Blend pool? node scripts/blend-verify.ts C... [C...] */
import { deployedByBlendFactory } from '../src/blend/factory.ts';
for (const id of process.argv.slice(2)) console.log(id.slice(0, 12), await deployedByBlendFactory(id).catch((e) => 'ERROR ' + e.message));
