/**
 * `cause` には API の生レスポンスなど、秘匿情報を含みうる文字列が入る。
 * ユーザーに見せてよいのは `format()` の出力だけで、`cause` は決して直接ログに出さないこと。
 * エラーオブジェクトをそのまま文字列化すると Node が cause chain を展開して出力する点に注意。
 */
export interface ErrorDetails {
  nextSteps?: string[];
  cause?: unknown;
  /**
   * API 由来のエラーの HTTP ステータス。呼び出し側が「404 だけは別扱いしたい」といった
   * 分岐をメッセージ文字列の一致ではなく型で書けるようにするためのもの。
   * メッセージ本文は将来変わりうるので、分岐に使ってはならない。
   */
  status?: number;
}

export class GasDeployError extends Error {
  readonly nextSteps: string[];
  /** API 由来のエラーの場合のみ設定される。`format()` には現れない。 */
  readonly status?: number;

  constructor(message: string, details: ErrorDetails = {}) {
    super(message, { cause: details.cause });
    this.name = 'GasDeployError';
    this.nextSteps = details.nextSteps ?? [];
    if (details.status !== undefined) {
      this.status = details.status;
    }
  }

  format(): string {
    if (this.nextSteps.length === 0) {
      return this.message;
    }
    const steps = this.nextSteps.map((step, i) => `  ${i + 1}. ${step}`);
    return [this.message, '', '次の手順を確認してください:', ...steps].join('\n');
  }
}

const API_DISABLED_MARKERS = ['Apps Script API has not been used', 'accessNotConfigured', 'SERVICE_DISABLED'];

export function classifyApiError(status: number, body: string): GasDeployError {
  if (status === 401) {
    return new GasDeployError('Apps Script API の認証に失敗しました (401)', {
      cause: body,
      status,
      nextSteps: [
        'refresh token が失効している可能性があります。OAuth 同意画面が「テスト」状態の場合、refresh token は7日で失効します。「本番」または「内部」に変更してください',
        'デプロイに使う Google アカウントのパスワードが変更されていないか確認してください',
        '認証情報を再発行し、GitHub Secrets を更新してください',
      ],
    });
  }

  if (status === 403) {
    const isApiDisabled = API_DISABLED_MARKERS.some((marker) => body.includes(marker));
    if (isApiDisabled) {
      return new GasDeployError('Apps Script API が有効化されていません (403)', {
        cause: body,
        status,
        nextSteps: [
          'https://script.google.com/home/usersettings を開き「Google Apps Script API」をオンにしてください',
          'GCP プロジェクト側でも Apps Script API を有効化してください',
          '設定の反映に数分かかる場合があります',
        ],
      });
    }
    return new GasDeployError('Apps Script プロジェクトへのアクセスが拒否されました (403)', {
      cause: body,
      status,
      nextSteps: [
        '認証に使ったアカウントに、対象スクリプトの編集権限があるか確認してください',
        '要求スコープに script.projects と script.deployments が含まれているか確認してください',
      ],
    });
  }

  if (status === 404) {
    return new GasDeployError('Apps Script プロジェクトが見つかりません (404)', {
      cause: body,
      status,
      nextSteps: [
        'scriptId が正しいか確認してください（スクリプトエディタの「プロジェクトの設定」で確認できます）',
        '認証に使ったアカウントに、対象スクリプトの閲覧権限があるか確認してください',
      ],
    });
  }

  return new GasDeployError(`Apps Script API がエラーを返しました (${status})`, {
    cause: body,
    status,
    nextSteps: ['しばらく待って再実行してください', 'Google Workspace のステータスダッシュボードで障害情報を確認してください'],
  });
}
