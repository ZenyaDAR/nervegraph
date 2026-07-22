import type { ScannerResult } from '../../graph/types.ts';
import type { Profile } from '../profile.ts';

export interface LanguageContext {
  profile: Profile;
}

/**
 * A language module owns everything needed to turn matching files into
 * RawRef[]: which files it claims, and how to read them. It knows nothing
 * about the filesystem beyond the file it's given — resolving a RawRef's
 * target to a node id is a separate concern, registered per rel type in
 * graph/resolvers/ (see docs/EXTENDING.md for the full recipe).
 */
export interface LanguageModule {
  id: string;
  matches(fileId: string, ctx: LanguageContext): boolean;
  scan(file: { id: string; content: string }, ctx: LanguageContext): ScannerResult;
}
