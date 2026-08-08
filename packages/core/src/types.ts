export type FileType = 'SERVER_JS' | 'HTML' | 'JSON';

export interface ScriptFile {
  name: string;
  type: FileType;
  source: string;
}

export interface Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface FileDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

export type ProjectType = 'webapp' | 'addon' | 'bound' | 'standalone';

export interface Deployment {
  deploymentId: string;
  versionNumber?: number;
  description?: string;
  webAppUrl?: string;
}
