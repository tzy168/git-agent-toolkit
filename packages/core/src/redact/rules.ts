/**
 * 脱敏规则表。
 * 每条规则都带正例 / 反例，单测按表遍历验证 —— 加规则必须同时加例子。
 */
export interface RedactRule {
  id: string;
  /** 规则用途，写进日志与报告说明段 */
  name: string;
  /** 必须带 g 标志 */
  pattern: RegExp;
  /** 替换文本，可用 $1 保留前缀 */
  replacement: string;
  examples: {
    /** 应当被改写 */
    positive: string[];
    /** 应当原样保留 */
    negative: string[];
  };
}

export const REDACT_RULES: RedactRule[] = [
  {
    id: 'openai-key',
    name: 'sk- 前缀密钥',
    pattern: /sk-[A-Za-z0-9_-]{16,}/g,
    replacement: '[REDACTED:KEY]',
    examples: {
      positive: ['apiKey = "sk-abcdefghijklmnopqrstuvwx"'],
      negative: ['const skill = "sk-no"'],
    },
  },
  {
    id: 'aws-akia',
    name: 'AWS Access Key ID',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED:AWS_KEY]',
    examples: {
      positive: ['aws_key = AKIA1234567890ABCDEF'],
      negative: ['const AKIA_TOO_SHORT = 1'],
    },
  },
  {
    id: 'github-token',
    name: 'GitHub Token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED:GITHUB_TOKEN]',
    examples: {
      positive: ['token: ghp_abcdefghijklmnopqrstuvwxyz012345'],
      negative: ['const ghp_short = 1'],
    },
  },
  {
    id: 'jwt',
    name: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: '[REDACTED:JWT]',
    examples: {
      positive: ['Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g'],
      negative: ['const name = "eyJ.too.short"'],
    },
  },
  {
    id: 'pem-private-key',
    name: 'PEM 私钥块',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:PRIVATE_KEY]',
    examples: {
      positive: ['-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----'],
      negative: ['-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'],
    },
  },
  {
    id: 'bearer',
    name: 'Authorization Bearer',
    pattern: /(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g,
    replacement: '$1[REDACTED:BEARER]',
    examples: {
      positive: ['headers: { Authorization: "Bearer abcdef1234567890abcdef" }'],
      negative: ['// Bearer short'],
    },
  },
  {
    id: 'authorization-value',
    name: 'Authorization 头的值',
    pattern: /((?:authorization|Authorization)\s*[:=]\s*["']?)[A-Za-z0-9._~+/\s=-]{16,}/g,
    replacement: '$1[REDACTED:AUTH]',
    examples: {
      positive: ['authorization: "Basic dXNlcm5hbWU6cGFzc3dvcmQxMjM0"'],
      negative: ['authorization: null'],
    },
  },
  {
    id: 'private-ip',
    name: '内网 IP',
    pattern: /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
    replacement: '[REDACTED:IP]',
    examples: {
      positive: ['host: 10.12.34.56', 'host: 192.168.1.100'],
      negative: ['host: 8.8.8.8', 'version: 1.10.2.3'],
    },
  },
  {
    id: 'internal-domain',
    name: '内网域名',
    pattern: /\b[A-Za-z0-9-]+\.(?:internal|corp|intranet|lan)\b/gi,
    replacement: '[REDACTED:HOST]',
    examples: {
      positive: ['url: https://api.payment.internal/v1'],
      negative: ['url: https://api.example.com/v1'],
    },
  },
  {
    id: 'cn-mobile',
    name: '中国大陆手机号',
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    replacement: '[REDACTED:PHONE]',
    examples: {
      positive: ['phone = "13800138000"'],
      negative: ['id = 10012345678', 'port = 1380013800'],
    },
  },
  {
    id: 'cn-id-card',
    name: '中国大陆身份证号',
    pattern: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
    replacement: '[REDACTED:ID_CARD]',
    examples: {
      positive: ['idCard = "11010519900307123X"'],
      negative: ['build = 123456789012345678'],
    },
  },
];

/** 命中即整体剔除文件的路径黑名单（默认项） */
export const DEFAULT_BLOCKED_PATTERNS: string[] = [
  '.env',
  '.env.*',
  '**/.env.*',
  '**/*secret*',
  '**/*credential*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/*token*.json',
];

/**
 * 邮箱默认不脱敏（git 元数据需要），仅当 security.redactEmails 开启时使用。
 * 邮箱的用户名部分保留首字符，避免完全破坏可读性。
 */
export const EMAIL_RULE: RedactRule = {
  id: 'email',
  name: '邮箱地址',
  pattern: /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
  replacement: '$1***@$2',
  examples: {
    positive: ['author = "zhangsan@example.com"'],
    negative: ['text = "not an email"'],
  },
};
