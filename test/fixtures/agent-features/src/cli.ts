import fs from 'node:fs';
import { helper } from './lib/helper';
import { other } from './lib/other';

fs.existsSync('.');
helper();
other();
