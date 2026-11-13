import { useState } from 'react';
import type { FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { applyToAll, choiceLabel, defaultChoice, situationText } from '../../lib/duplicates';
import type { DuplicateCheck, DuplicateChoice } from '../../lib/duplicates';

export interface DuplicateQuestion { key: string; fileName: string; check: DuplicateCheck }

interface Props {
  questions: DuplicateQuestion[];
  onSubmit: (choices: Record<string, DuplicateChoice>) => void;
}

const ALL_LABELS: Record<DuplicateChoice, string> = {
  skip: 'Không tải tất cả', new: 'Tải mới tất cả', restore: 'Khôi phục tất cả từ thùng rác', supplement: 'Bổ sung bản gốc cho tất cả',
};

export function DuplicateDialog({ questions, onSubmit }: Props) {
  const [choices, setChoices] = useState<Record<string, DuplicateChoice>>(() =>
    Object.fromEntries(questions.map((question) => [question.key, defaultChoice(question.check)])));
  const choiceOf = (question: DuplicateQuestion) => choices[question.key] ?? defaultChoice(question.check);
  const offered = (['skip', 'new', 'restore', 'supplement'] as DuplicateChoice[]).filter((choice) =>
    questions.filter((question) => question.check.options.includes(choice)).length > 1);
  const skipAll = () => onSubmit(Object.fromEntries(questions.map((question) => [question.key, 'skip' as const])));

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(Object.fromEntries(questions.map((question) => [question.key, choiceOf(question)])));
  }

  return <Modal kicker="TỆP ĐÃ CÓ" title={questions.length === 1 ? `“${questions[0].fileName}” đã có trong thư viện` : `${questions.length} tệp đã có trong thư viện`} onClose={skipAll}>
    <form className="dialog-form" onSubmit={submit}>
      {questions.length > 1 && offered.length > 0 && <div className="duplicate-all" role="group" aria-label="Áp dụng cho tất cả">
        <span>Áp dụng cho tất cả:</span>
        {offered.map((choice) => <button key={choice} type="button" className="action-button"
          onClick={() => setChoices((current) => applyToAll(questions, choice, current))}>{ALL_LABELS[choice]}</button>)}
      </div>}
      <ul className="duplicate-list">
        {questions.map((question) => <li key={question.key}>
          <strong>{question.fileName}</strong>
          <p>{situationText(question.check)}</p>
          <div className="duplicate-options" role="radiogroup" aria-label={`Cách xử lý ${question.fileName}`}>
            {question.check.options.map((option) => <label key={option} className={choiceOf(question) === option ? 'selected' : undefined}>
              <input type="radio" name={`duplicate-${question.key}`} checked={choiceOf(question) === option}
                onChange={() => setChoices((current) => ({ ...current, [question.key]: option }))} />
              <span>{choiceLabel(option, question.check)}</span>
            </label>)}
          </div>
        </li>)}
      </ul>
      <div className="summary-dialog-actions dialog-actions">
        <button type="button" className="button-secondary" onClick={skipAll}>Không tải tệp nào</button>
        <button type="submit" className="button-primary dialog-submit" autoFocus>Tiếp tục</button>
      </div>
    </form>
  </Modal>;
}
