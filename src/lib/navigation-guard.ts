const indexKey = "__layaNavigationIndex";

export function confirmDiscard(browser: Window = window) {
  return (
    !browser.document.querySelector('[data-unsaved-changes="true"]') ||
    browser.confirm(
      "저장하지 않은 변경사항이 있습니다. 저장하지 않고 이동할까요?",
    )
  );
}

export function installNavigationGuard(browser: Window) {
  const history = browser.history;
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  const navigation = (
    browser as Window & {
      navigation?: { currentEntry?: { index: number } };
    }
  ).navigation;
  const entryIndex = (state: Record<string, unknown> | null) => {
    const nativeIndex = navigation?.currentEntry?.index;
    return nativeIndex !== undefined && nativeIndex >= 0
      ? nativeIndex
      : typeof state?.[indexKey] === "number"
        ? (state[indexKey] as number)
        : undefined;
  };
  const route = () => {
    const url = new URL(browser.location.href);
    return url.pathname + url.search;
  };
  let currentIndex = entryIndex(history.state) ?? 0;
  let currentRoute = route();
  let restoringIndex: number | undefined;
  const push: History["pushState"] = function (state, title, url) {
    const nextIndex = currentIndex + 1;
    originalPush.call(history, { ...state, [indexKey]: nextIndex }, title, url);
    currentIndex = entryIndex(history.state) ?? nextIndex;
    currentRoute = route();
  };
  const replace: History["replaceState"] = function (state, title, url) {
    originalReplace.call(
      history,
      { ...state, [indexKey]: currentIndex },
      title,
      url,
    );
    currentRoute = route();
  };
  history.pushState = push;
  history.replaceState = replace;
  replace(history.state, "");
  const onPopState = (event: PopStateEvent) => {
    const targetIndex = entryIndex(event.state);
    if (restoringIndex !== undefined) {
      event.stopImmediatePropagation();
      if (targetIndex === restoringIndex) restoringIndex = undefined;
      else if (targetIndex !== undefined)
        history.go(restoringIndex - targetIndex);
      return;
    }
    if (typeof targetIndex !== "number") return;
    if (route() !== currentRoute && !confirmDiscard(browser)) {
      // Keep the form mounted while returning to the entry the user declined to leave.
      event.stopImmediatePropagation();
      restoringIndex = currentIndex;
      history.go(currentIndex - targetIndex);
      return;
    }
    currentIndex = targetIndex;
    currentRoute = route();
  };
  browser.addEventListener("popstate", onPopState, true);
  return () => {
    browser.removeEventListener("popstate", onPopState, true);
    if (history.pushState === push) history.pushState = originalPush;
    if (history.replaceState === replace)
      history.replaceState = originalReplace;
  };
}
