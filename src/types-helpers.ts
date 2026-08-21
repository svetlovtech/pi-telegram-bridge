// Minimal structural type for an ask_user_question answer, mirroring the
// `QuestionAnswer` interface used by the rpiv-ask-user-question fork.
export interface QuestionAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
  notes?: string;
  preview?: string;
}
