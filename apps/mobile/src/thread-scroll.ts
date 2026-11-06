type ScrollPosition = { contentSize: { height: number }; layoutMeasurement: { height: number }; contentOffset: { y: number } };
type Options = {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  scrollToLatest: () => void;
  onFollowingChange: (following: boolean) => void;
  isCurrent: () => boolean;
};

// Geometry-generated scroll events must not undo an explicit open/send follow.
// Only the reader's own scrolling changes whether incoming messages are followed.
export function createThreadScroll(options: Options) {
  let active = true, following = true, interacting = false, frame: number | undefined;
  const current = () => active && options.isCurrent();
  function cancel() { if (frame !== undefined) options.cancelFrame(frame); frame = undefined; }
  function follow(value: boolean) {
    if (!current() || following === value) return;
    following = value;
    options.onFollowingChange(value);
  }
  function geometryChanged() {
    if (!current() || !following || interacting || frame !== undefined) return;
    frame = options.requestFrame(() => {
      frame = undefined;
      if (current() && following && !interacting) options.scrollToLatest();
    });
  }
  return {
    geometryChanged,
    isFollowing: () => current() && following,
    requestLatest() { if (!current()) return; interacting = false; follow(true); geometryChanged(); },
    preserveHistory() { if (!current()) return; cancel(); follow(false); },
    beginInteraction() { if (!current()) return; interacting = true; cancel(); follow(false); },
    scroll(position: ScrollPosition) {
      if (current() && interacting) follow(position.contentSize.height - position.layoutMeasurement.height - position.contentOffset.y < 90);
    },
    endInteraction() { interacting = false; geometryChanged(); },
    dispose() { active = false; cancel(); }
  };
}
