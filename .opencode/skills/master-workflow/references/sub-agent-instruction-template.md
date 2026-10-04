# Sub-Agent Instruction Template

Every instruction package sent from Main → Sub should follow this structure. Do not omit sections. Adapt the content, never the skeleton.

---

## 1. Role & Goal

You are a focused sub-agent. Your sole responsibility is:

**[One clear sentence stating the exact outcome required]**

## 2. Context (Minimal Necessary)

[Only the facts the sub-agent cannot function without. Do not paste the full conversation. Prefer structured data over narrative.]

- Relevant user requirements:
- Scope / non-goals:
- Key prior decisions or artifacts:
- Dependencies / inputs you are receiving:

## 3. Inputs & Dependencies

List every required input explicitly.

- Input/artifact:
- Location or identifier:
- Upstream task(s), if any:
- Preconditions that must already be true:

## 4. Detailed Instructions

[Concrete steps, decision rules, and checks. State what to inspect, produce, modify, or test.]

1. ...
2. ...
3. ...

## 5. Constraints & Guardrails

- Must:
- Must not:
- Scope boundaries / non-goals:
- Quality requirements:
- Tools or resources you may use:
- Tools or resources you must not use:
- Data / security / privacy constraints:

## 6. Expected Output Format

[Specify the exact structure required for integration. Use headings, schemas, tables, or file/path conventions.]

```text
STATUS: COMPLETED | BLOCKED | FAILED | PARTIAL
TASK_ID: <stable task id>
RESULT: <concise result statement>
ARTIFACTS: <paths/ids or NONE>
KEY_FINDINGS:
- <finding>
ASSUMPTIONS:
- <assumption or NONE>
RISKS_OR_GAPS:
- <risk/gap or NONE>
VERIFICATION: <PASSED | FAILED | NOT_RUN>
PROVENANCE: <sources/artifact references or NONE>
NEXT_ACTION: <specific next step or NONE>
```

## 7. Verification Plan

[Define what must be verified before the work can be accepted.]

- Verification target:
- Checks to perform:
- Evidence required:
- Independent reviewer required: YES | NO

Do not report `VERIFICATION: PASSED` unless the stated checks were actually performed.

## 8. Success Criteria

The work is complete only when all of the following are true:

- [ ] Criterion 1 (binary / testable)
- [ ] Criterion 2
- [ ] Criterion 3

## 9. What to Do If Stuck

If you cannot complete the task as specified:

1. Stop before inventing facts, artifacts, or outcomes.
2. Return a status report containing:
   - What you completed
   - What is blocked
   - Why it is blocked
   - Which dependency, capability, or requirement caused the block
   - Proposed options, when useful
3. Do not silently expand scope.
4. Do not mark the task completed.

---

## Quality Checklist for Main Agent (before sending)

Before finalizing any sub-agent instruction, verify:

- [ ] Goal is singular and unambiguous.
- [ ] Context contains zero unnecessary history.
- [ ] Scope and non-goals are explicit.
- [ ] Every required input has a concrete location or identifier.
- [ ] Dependencies and preconditions are named.
- [ ] Instructions are concrete enough to execute without guessing.
- [ ] Guardrails cover relevant quality and data/safety boundaries.
- [ ] Output format is strict enough for downstream integration.
- [ ] Success criteria are binary / testable.
- [ ] Verification requirements are explicit.
- [ ] The blocked-path behavior is explicit.
- [ ] The sub-agent can succeed without asking avoidable clarification questions back to Main.
