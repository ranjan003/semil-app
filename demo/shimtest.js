import { Buffer } from 'node:buffer';
import nodeCrypto from 'node:crypto';
import * as sh from './shims/crypto.js';
import { Buffer as B2 } from './shims/buffer.js';
const a = nodeCrypto.createHash('sha256').update('héllo'.repeat(40)).digest('hex'), b = sh.createHash('sha256').update('héllo'.repeat(40)).digest('hex');
const k = nodeCrypto.createHmac('sha256', 'seed').update('select:0').digest('hex'), k2 = sh.createHmac('sha256', 'seed').update('select:0').digest('hex');
const big = 'x'.repeat(200); const k3 = nodeCrypto.createHmac('sha256', big).update(Buffer.alloc(8)).digest('hex'), k4 = sh.createHmac('sha256', big).update(B2.alloc(8)).digest('hex');
console.log(a === b, k === k2, k3 === k4);
