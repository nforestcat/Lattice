import type { NoteTemplate, PromptTemplate } from "../api/types";

export const DEFAULT_NOTE_TEMPLATES: NoteTemplate[] = [
  {
    name: "Meeting Notes",
    description: "Template for recording meetings, attendees, action items, and notes.",
    prompt: "A meeting notes document. Include frontmatter with 'type: meeting', 'date', and 'participants'. The body should have sections for 'Agenda', 'Discussion Notes', and 'Action Items' (with checkboxes)."
  },
  {
    name: "Project Spec",
    description: "Template for drafting technical specs, requirements, and milestones.",
    prompt: "A project spec document. Include frontmatter with 'type: project', 'status: planning', and 'owner'. The body should have sections for 'Background', 'Proposed Changes', and 'Milestones'."
  },
  {
    name: "Daily Log",
    description: "Template for documenting daily progress, blockers, and goals.",
    prompt: "A daily log entry. Include frontmatter with 'type: log' and 'date'. The body should have sections for 'Completed Today', 'Blockers', and 'Goals for Tomorrow'."
  }
];

export const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: "summarize",
    name: "Summarize",
    template: "Provide a clear and concise summary of the key concepts, main ideas, and critical details from the provided context. Structure the response with bullet points for readability.",
    isSystem: true
  },
  {
    id: "code-review",
    name: "Code Review",
    template: "Perform a detailed code review of the source code in the context. Analyze code quality, potential bugs, performance bottlenecks, and adherence to clean coding best practices. Propose concrete improvements.",
    isSystem: true
  },
  {
    id: "critique",
    name: "Design Critique",
    template: "Critically analyze the design, architecture, or approach described in the context. Point out structural weaknesses, hidden assumptions, scalability concerns, and trade-offs. Recommend alternative solutions.",
    isSystem: true
  },
  {
    id: "todo",
    name: "Extract TODOs",
    template: "Scan the provided context and extract all explicit and implicit action items, TODOs, bugs to fix, or future extension ideas. Organize them by priority or component.",
    isSystem: true
  },
  {
    id: "document",
    name: "Documentation",
    template: "Generate comprehensive documentation for the concepts, components, or APIs present in the context. Use clear markdown headers, code block examples, and explanations of inputs and outputs.",
    isSystem: true
  }
];
