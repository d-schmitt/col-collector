# Col Collector interface

## Product and visual direction

A personal cycling passport for discovering Alpine passes and recording rides.
The primary interaction is map or collection → pass → approach → ascent.
The collectible card is the only repeating card metaphor; the journal and
approaches use readable lists rather than nested cards.

The interface uses the Copilot canvas semantic background, text, border, focus
and font tokens when available, with light, outdoor-inspired fallbacks.
Alpine green denotes actionable controls and completed rides in the collection.
On the map, completed passes use magenta, larger markers and a stronger white
outline to stand out against green terrain; the map legend matches.
Summit elevation is prominent; group membership always follows the source map.

## Completion

Unridden cards use a grayscale, original mountain illustration. Completed cards
use color, a checkmark and an explicit "Collected" label. An uploaded photo
replaces the illustration for that pass. The illustration is not geographically
accurate and the detail view labels it accordingly.

A pass is collected after any one of its approaches has an ascent. Individual
approaches remain independently tracked. Progress counts unique passes, not
ascents. Deleting the final ascent reverses completion.

## Layout and interactions

- Map and collection are separate views with shared filters.
- Map browsing shows a corresponding list of passes in the current bounds.
- Pass details replace the explorer instead of opening a small modal.
- At narrow widths, details stack and the collection uses two compact columns.
- Source-verified approaches display metrics and links. Unverified approaches
  explicitly say their metrics are unknown.
- Forms use visible labels; dates, photos and notes are optional.
- Destructive actions use an in-document confirmation dialog, not host-native
  JavaScript dialogs that may be blocked inside an iframe.
- Failed saves retain the draft. Conflicting writes require an explicit reload
  before retrying. Loading, empty, network-error and success states are visible.

## Accessibility

Completion does not depend on color alone. Cards and map alternatives are
keyboard-accessible; the card list provides the non-map exploration path.
Focus indicators, live result counts, error announcements, skip navigation,
responsive layouts, and reduced-motion behavior are included. Decorative
landscapes use empty alt text; personal photos have descriptive contextual text.
