# Background: why the method works this way

The reasons behind the rules in [SKILL.md](SKILL.md), and typical cases.

## Why the conditions are fixed

A frame's time depends on everything the GPU does, not only on the page. Each of these has
made a run measure the wrong thing:

- Another client on the GPU. A browser pane hidden from view kept rendering a video and spoiled
  the timings on three separate days. A page in another app's hidden pane once took half the GPU.
  CPU load beside a run slowed the GPU too.
- A setting left free. A comparison without a fixed pixel ratio voided a pre-merge performance
  check: the two sides rendered different pixel counts. A dynamic resolution moves the pixel
  count by itself, so the project's profiler pins its scale for a comparison.
- Timestamp queries. With them on, the browser ran the same frames up to a quarter faster on one
  GPU (the profiler's own notes), so a frame rate is read from a run without them, and a split by
  pass from a run with them; deltas taken in one mode cancel the bias.
- A development build: unminified code, checks and hot reload change the CPU's share and the
  load's timing.

## Why the noise is measured first

Two pages of one build are not equal by default. One recorded A/A gave the page opened last a
median frame interval 7 to 17 % longer, beyond the 95 % interval, while the GPU time showed no
difference: the page behind the other in the window paced its frames otherwise. An A/B had read a
build's gain as a loss before the tool brought each page to the front while it ran.
An earlier form of the same comparison favoured the page loaded first. Without an A/A neither
bias is visible, and every A/B carries it.

A switch inside one page compares two states under the same load, caches and pacing, a few
frames apart; it is the most precise A/B there is, and the slowest drift cancels when the
blocks alternate (A B B A).

## Why the frame is split by pass, and how

A tile-based GPU starts a pass's vertex work long before the passes it reads have finished, so a
pass's start and end timestamps overlap other passes, and raw intervals summed to several times
the frame. The profiler charges each pass the time it adds to the GPU's timeline instead.
Even so, one pass's figure can carry another's work: in one case the timestamps
put the time on the sea's displacement pass. Switching the pass off and reading the total is the
check.

Splitting a cost into a fixed part and a part per pixel tells which optimisation can work. The
meadow's GPU time was the same at 1440p and at native 4K: it was bound by its vertices, and the
change that saved about a quarter of it removed vertex work, not fragment work.

## Why the gain is proven first

The cheapest stand-in bounds what any optimisation can win. A flat shader on the vegetation's
coverage draws saved almost as much as hiding them, which showed the cost was fragment shading
before a depth prepass was built to remove it. In the other direction, an
optimisation can come out byte-identical and save nothing, or its premise can fall at the first
cheap reading; either way the work stops there, before any build.

A quality knob is swept on the image first: four of the top tier's knobs were swept against their
original values in their worst views and scored with a perceptual metric, with one point finer
than the original to show the error any change of sampling brings; each took the cheapest value
before the error began to rise. Timing only near that knee
saves the long runs.

## Why the image stays the same

A performance change that also moves the picture cannot be judged on either: the time saved may
come from drawing less, and the picture change is reviewed as a speed-up. Keeping the default
path byte-identical makes the image check a yes or no, and a deliberate picture change gets its
own commit and its own comparison.

## Why relative numbers

Milliseconds belong to one machine, one driver and one display. A percentage of the frame or of
the pass, with the A/A's spread beside it, carries to another machine; results are stated
this way ("about a quarter less GPU time", "no measurable change" in the weathers a change
did not target).

## Sources

- NVIDIA, FLIP (<https://github.com/NVlabs/flip>): its repository describes it as a tool for
  visualising and communicating the errors in rendered images. It is the perceptual metric the
  knob sweeps above were scored with.
