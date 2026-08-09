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

/**
 * 作成済みのバージョン（スクリプト内容のスナップショット）。
 * Apps Script API にバージョンの削除手段は無く、一度作られたバージョンは永続する。
 * ロールバックが「過去のバージョンを指し直すだけ」で成立するのはこの性質による。
 */
export interface Version {
  versionNumber: number;
  description?: string;
  createTime?: string;
}
