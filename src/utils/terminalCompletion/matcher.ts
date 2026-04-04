import type { CompletionCandidate, CompletionContext, CompletionEdit, CompletionResult } from './types';

function uniqueKey(candidate: CompletionCandidate) {
  return [
    candidate.kind,
    candidate.replaceStart,
    candidate.replaceEnd,
    candidate.insertText,
    candidate.commitSuffix ?? '',
    candidate.source,
  ].join('::');
}

function compareCandidates(left: CompletionCandidate, right: CompletionCandidate) {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }

  if (left.isDir !== right.isDir) {
    return left.isDir ? -1 : 1;
  }

  const label = left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
  if (label !== 0) {
    return label;
  }

  return left.source.localeCompare(right.source, undefined, { sensitivity: 'base' });
}

function dedupeCandidates(candidates: CompletionCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = uniqueKey(candidate);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getCurrentRaw(context: CompletionContext, candidate: CompletionCandidate) {
  return context.inputText.slice(candidate.replaceStart, candidate.replaceEnd);
}

function longestCommonPrefix(values: string[]) {
  if (values.length === 0) return '';
  let prefix = values[0] ?? '';

  for (let index = 1; index < values.length; index += 1) {
    const value = values[index] ?? '';
    while (prefix && !value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
    if (!prefix) break;
  }

  return prefix;
}

export function candidateToEdit(candidate: CompletionCandidate): CompletionEdit {
  return {
    replaceStart: candidate.replaceStart,
    replaceEnd: candidate.replaceEnd,
    newText: `${candidate.insertText}${candidate.commitSuffix ?? ''}`,
  };
}

export function buildCompletionResult(
  context: CompletionContext,
  candidates: CompletionCandidate[],
): CompletionResult {
  const deduped = dedupeCandidates(candidates).sort(compareCandidates);
  const prefixBase = deduped.find((candidate) => candidate.kind !== 'history');

  if (!prefixBase) {
    return { candidates: deduped };
  }

  const prefixCandidates = deduped.filter(
    (candidate) =>
      candidate.kind !== 'history' &&
      candidate.replaceStart === prefixBase.replaceStart &&
      candidate.replaceEnd === prefixBase.replaceEnd,
  );

  if (prefixCandidates.length < 2) {
    return { candidates: deduped };
  }

  const prefix = longestCommonPrefix(prefixCandidates.map((candidate) => candidate.insertText));
  const currentRaw = getCurrentRaw(context, prefixBase);
  if (!prefix || prefix === currentRaw) {
    return { candidates: deduped };
  }

  return {
    candidates: deduped,
    commonPrefixEdit: {
      replaceStart: prefixBase.replaceStart,
      replaceEnd: prefixBase.replaceEnd,
      newText: prefix,
    },
  };
}
