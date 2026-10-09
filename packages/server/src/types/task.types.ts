export interface SubtaskDefinition {
  id: string;
  title: string;
  instructions: string;
  priority: "high" | "medium" | "low";
}
