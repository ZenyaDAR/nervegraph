import { helper } from '../src/lib/helper';

if (helper() !== 1) throw new Error('helper');
