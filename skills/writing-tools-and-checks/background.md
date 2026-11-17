# Background: why the method works this way

The reasons behind the rules in [SKILL.md](SKILL.md), and the cases they come from: a renderer's
project developed mostly by agents, where scripts were written again and again for the same
questions until they became tools, and where rules written as text were broken again until they
became checks. Cases are cited by commit hash where the commit says it.

## Why one tool per question, found before it is written

An agent that does not find a tool writes one, and its script repeats the mistakes the tool had
already fixed. Left alone, agents write hundreds of one-off browser scripts to read a value from
the page, most without the GPU lock and all in a cold browser profile; one probe tool replaced
them. The rule that a grown page draws what a fresh load of its land draws was checked by five
local copies of one script, each holding the lock while pages prepared; one shared check replaced
them. Agents polled long runs with sleep loops of their own, thousands of waits, some on a line
that never reached their log; one job runner with a bounded wait replaced them.

Adding an option to a tool that almost fits keeps the fixes in one place. A second tool for the
same question means the next fix lands in one copy and not the other.

## Why the manual is the header, and --help does nothing else

A manual kept elsewhere drifts from the code; a header is read and changed with it. Agents read the
first lines of a file and the output of `--help`, so the question the tool answers comes first,
and the facts a caller needs (how to call it, what it writes, what it holds, what its exit codes
mean) follow in a fixed order. Anthropic's guidance on tools for agents asks the same: describe a
tool as you would to a new colleague, return only what the reader acts on, and make an error say
what to do next.

The GNU coding standards say a program's `--help` prints brief documentation on standard output,
exits successfully, ignores the other options and does not perform the program's normal function.
For a renderer the last clause matters most: a GPU tool started only to see its options queues
for the lock and renders. Answering `--help` before any other import runs makes that impossible,
and a check that runs every tool's `--help` with the lock and the browser made to throw keeps it so.

## Why exit codes mean one thing each

Callers (the commit check, a job runner, another agent) read the exit code, not the text. The GNU C
Library's manual gives 0 for success and 1 for failure, and notes that comparison programs such as
`diff` use 1 for a mismatch and 2 for being unable to compare. The same distinction matters for a
check on a shared GPU: "the GPU was busy, nothing was measured" must not read as "passed", nor as a
regression, so it gets a code of its own.

## Why readiness comes from the system

A fixed count of forty ready frames captured a page that was still settling, made a settled page
wait out the count, and landed on sparse frame-to-frame noise in about a sixth of loads, so two
captures of one build differed. A sleep or a frame count is a guess about how long the system takes,
and the guess fails when the machine is busy. Waiting for the system's own signal (the frame is
final, the state is applied, a frame was rendered after it) answers the question the wait stands
for.

## Why the project's facts come from one configuration

A generic tool that names the project's globals, addresses and tables cannot be reused, and every
rename has to find all the copies. Reading them from one configuration file, and checking that the
generic tools name nothing else of the project, keeps the tools movable to another project and the
renames in one place.

## Why the architecture first, and text last

A rule written as text is followed by the change whose author remembers it and broken by the next
one. A prose-only rule in the rules file can become a lint rule. To show that the lint rule reports
the error, run it on the file as it was before a real fix of that error. Making the mistake
impossible costs nothing per change: an import that cannot resolve needs no
review. Yaron Minsky's "make illegal states unrepresentable" names the same preference for types:
a state the types cannot express need not be checked. A lint rule or a check catches what the
structure allows; text is left for what only judgement can see.

## Why a check is proven by planting its fault

A check that has never failed may test nothing: a selector that matches no code, a comparison of a
thing with itself, a wait that reads the previous frame. Mutation testing measures a test suite the
same way, by making small changes to the program and counting the tests that notice. A check can
carry an option that loads the wrong input only to see it fail. A check written for a bug is run on
the code that had the bug. Each lint rule has a fixture with the bad lines marked and the good ones
beside them.

A check made faster can lose its guarantee without failing: a scene-jump check that compares a jump
with another jump instead of a fresh load passes when both jumps are wrong in the same way.

## Why known-case lists only shrink

A list of exceptions that grows hides new failures behind old ones, and an entry for a case already
fixed lets the mistake come back unnoticed. A list that fails on a new case and on an entry no
longer needed only gets shorter.

## Why checks run where they cost nothing

A check run with every commit protects every commit; one run by hand protects only the change whose
author remembered it. Checks that need no GPU run in seconds and while another session holds the
GPU, so they go into the commit check, which is kept near a minute so that nobody skips it. Checks
that render take the GPU and minutes, so they are named beside the kind of change that needs them,
where the author of that change reads.

## Why a tolerance is set as the industry sets it

A threshold chosen to make a failing run pass turns a cause into noise. Engine screenshot tests set
a per-pixel threshold and bounds on the share of differing pixels over the frame and over small
parts of it. A temporal tolerance is calibrated from every A/A pair of one build and from synthetic
regressions that must fail; the method is in `verifying-rendering-changes`.

## Sources

- GNU Coding Standards, `--help`
  (<https://www.gnu.org/prep/standards/html_node/_002d_002dhelp.html>): brief documentation on
  standard output, exit successfully, ignore other options, do not perform the normal function.
- The GNU C Library manual, Exit Status
  (<https://sourceware.org/glibc/manual/latest/html_node/Exit-Status.html>): 0 for success and 1
  for failure; comparison programs use 1 for a mismatch and 2 for an inability to compare.
- Anthropic, Writing effective tools for AI agents
  (<https://www.anthropic.com/research/writing-tools-for-agents>): describe a tool as to a new
  colleague, return high-signal information, make errors specific and actionable.
- Yaron Minsky, Effective ML Revisited, Jane Street blog
  (<https://blog.janestreet.com/effective-ml-revisited/>): "make illegal states unrepresentable".
- Mutation testing, Wikipedia (<https://en.wikipedia.org/wiki/Mutation_testing>): a test suite is
  evaluated by making small changes to the program it tests.
