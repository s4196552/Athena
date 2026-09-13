import { ICON_PATHS } from './paths';

/* Tag -> icon.
 *
 * Lookup is `kind:name`, then `name`, then the kind's default. The compound
 * key is load-bearing rather than defensive: `source-code` exists as both a
 * doctype ("this file is code") and a pattern ("code was found inside this
 * file"), and they want different icons.
 *
 * An unmapped tag gets its kind's icon, never a blank. There are 103 keywords
 * in the seed and no sane person is drawing 103 icons; the point of the icon
 * is to make the AXIS readable at a glance in a wall of grey chips, and the
 * name next to it does the rest.
 */

const KIND_DEFAULT: Record<string, string> = {
  doctype: 'description',
  topic: 'label',
  author: 'person',
  date: 'calendar_month',
  pattern: 'find_in_page',
  entity: 'bookmark',
  custom: 'star',
  user: 'star',
  keyword: 'tag',
  object: 'category',
  scene: 'image',
  place: 'folder',
};

const BY_NAME: Record<string, string> = {
  // topics
  'topic:finance': 'payments',
  'topic:legal': 'gavel',
  'topic:hr': 'groups',
  'topic:engineering': 'engineering',
  'topic:marketing': 'campaign',
  'topic:sales': 'trending_up',
  'topic:research': 'science',
  'topic:medical': 'medical_services',
  'topic:education': 'school',
  'topic:operations': 'settings',
  'topic:security': 'shield',
  'topic:personal': 'person',
  'topic:travel': 'flight',
  'topic:design': 'palette',

  // doctypes
  'doctype:invoice': 'receipt_long',
  'doctype:receipt': 'receipt',
  'doctype:statement': 'account_balance',
  'doctype:contract': 'handshake',
  'doctype:report': 'assessment',
  'doctype:presentation': 'slideshow',
  'doctype:spreadsheet': 'table_chart',
  'doctype:log': 'terminal',
  'doctype:source-code': 'code',
  'doctype:resume': 'badge',
  'doctype:letter': 'mail',
  'doctype:meeting-notes': 'event_note',
  'doctype:form': 'list_alt',
  'doctype:paper': 'article',
  'doctype:manual': 'menu_book',
  'doctype:policy': 'policy',
  'doctype:proposal': 'lightbulb',
  'doctype:transcript': 'record_voice_over',
  'doctype:screenshot': 'screenshot',
  'doctype:certificate': 'workspace_premium',
  'doctype:photo': 'photo_camera',
  'doctype:recording': 'mic',

  // patterns -- the structural findings, which are the ones worth a glyph
  'pattern:money': 'paid',
  'pattern:invoice-number': 'numbers',
  'pattern:amount-due': 'request_quote',
  'pattern:tax-id': 'account_balance_wallet',
  'pattern:iban': 'account_balance',
  'pattern:accounting-period': 'date_range',
  'pattern:log-line': 'list',
  'pattern:severity-level': 'warning',
  'pattern:stack-trace': 'bug_report',
  'pattern:source-code': 'code',
  'pattern:sql': 'database',
  'pattern:url': 'link',
  'pattern:email-address': 'alternate_email',
  'pattern:phone-number': 'call',
  'pattern:ip-address': 'lan',
  'pattern:credentials': 'key',
  'pattern:signature-block': 'draw',
  'pattern:citation': 'format_quote',
  'pattern:percentage': 'percent',
  'pattern:screenshot-name': 'screenshot',
};

const MEDIA: Record<string, string> = {
  image: 'image',
  video: 'movie',
  audio: 'music_note',
  document: 'description',
  other: 'draft',
};

/** The icon name for a tag. Always resolves to something drawable. */
export function iconForTag(kind: string, name: string): string {
  return BY_NAME[`${kind}:${name}`] ?? KIND_DEFAULT[kind] ?? 'tag';
}

export function iconForMedia(mediaType: string): string {
  return MEDIA[mediaType] ?? 'draft';
}

export function iconForKind(kind: string): string {
  return KIND_DEFAULT[kind] ?? 'tag';
}

/* Rendered as an inline SVG rather than an <img>, so it inherits currentColor
 * -- which is what lets one chip component tint its icon with the workspace
 * accent when selected and the muted grey when not. */
export function Icon({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const d = ICON_PATHS[name] ?? ICON_PATHS.tag;
  return (
    <svg
      viewBox="0 -960 960 960"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden="true"
      focusable="false"
      style={{ flex: '0 0 auto', display: 'block' }}
    >
      <path d={d} />
    </svg>
  );
}

/** Convenience: the icon for a tag, given the tag. */
export function TagIcon({
  kind,
  name,
  size = 14,
  className,
}: {
  kind: string;
  name: string;
  size?: number;
  className?: string;
}) {
  return <Icon name={iconForTag(kind, name)} size={size} className={className} />;
}
