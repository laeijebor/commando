/** A guide in the format the guide skill documents, for the model and view tests. */
export const GUIDE = `# Stripe webhook rollout

## Phase 1

<callout tone="warn" title="Before you merge #527">

These keep **live** billing working.

</callout>

1. **Get the platform signing secret.**
   - [ ] Stripe → Live mode → \`graphql\` → copy {#copy-platform}
2. **Store it in Doppler.**
   - [ ] Store the platform secret in Doppler: {#store-platform}

     \`\`\`sh
     pbpaste | doppler secrets set X
     \`\`\`
   - [x] Railway sync is configured (I checked)

<checkpoint id="phase-1">Phase 1 done — both secrets match</checkpoint>

Press <kbd>Cmd</kbd> then <checkpoint done>Inline reached</checkpoint> to finish.

<details><summary>Why</summary>

Because.

</details>
`
