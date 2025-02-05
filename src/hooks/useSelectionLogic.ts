import { RefObject, useCallback, useEffect, useRef } from 'react';
import { SelectionContainerRef, OnSelectionChange, Point, SelectionBox, Box } from '../utils/types';
import { calculateBoxArea, calculateSelectionBox } from '../utils/boxes';

export interface UseSelectionLogicResult {
  cancelCurrentSelection: () => void;
}

export interface UseSelectionLogicParams<T extends HTMLElement> {
  /** This callback will fire when the user starts selecting */
  onSelectionStart?: (event: MouseEvent | ToggleEvent) => void;
  /** This callback will fire when the user finishes selecting */
  onSelectionEnd?: (event: MouseEvent | ToggleEvent) => void;
  /** This callback will fire when the user's mouse changes position while selecting using requestAnimationFrame */
  onSelectionChange?: OnSelectionChange;
  /** This boolean enables selecting  */
  isEnabled?: boolean;
  /** This is an HTML element that the mouse events (mousedown, mouseup, mousemove) should be attached to. Defaults to the document.body */
  eventsElement?: T | null;
  /** This is the ref of the parent of the selection box  */
  containerRef: RefObject<SelectionContainerRef>;
  /**
   * If supplied, this callback is fired on mousedown and can be used to prevent selection from starting.
   * This is useful when you want to prevent certain areas of your application from being able to be selected.
   * Returning true will enable selection and returning false will prevent selection from starting.
   *
   * @param {EventTarget | null} target - The element the mousedown event fired on when the user started selected
   */
  shouldStartSelecting?: (target: EventTarget | null, event: MouseEvent | ToggleEvent) => boolean;

  /**
   * Determines whether a selection's dimensions meet the criteria for initiating a selection.
   * The purpose is to distinguish between clicks and the start of a selection gesture.
   *
   * The default implementation checks if the area of the box (width * height) is greater than 10.
   *
   * @returns `true` if the box dimensions meet the threshold for starting a selection, otherwise `false`.
   */
  isValidSelectionStart?: (box: Box) => boolean;
}

/**
 * This hook contains logic for selecting. It starts 'selection' on mousedown event and finishes it on mouseup event.
 * When mousemove event is detected and user is selecting, it calls onSelectionChange and containerRef.drawSelectionBox
 */
export function useSelectionLogic<T extends HTMLElement>({
  containerRef,
  onSelectionChange,
  onSelectionStart,
  onSelectionEnd,
  isEnabled = true,
  eventsElement,
  shouldStartSelecting,
  isValidSelectionStart = isMinumumBoxArea,
}: UseSelectionLogicParams<T>): UseSelectionLogicResult {
  const startPoint = useRef<null | Point>(null);
  const endPoint = useRef<null | Point>(null);
  const isSelecting = useRef(false);

  // these are used in listeners attached to eventsElement. They are used as refs to ensure we always use the latest version
  const currentSelectionChange = useRef(onSelectionChange);
  const currentSelectionStart = useRef(onSelectionStart);
  const currentSelectionEnd = useRef(onSelectionEnd);
  const onChangeRefId = useRef<number | undefined>();
  const isEnabledRef = useRef(isEnabled);

  currentSelectionChange.current = useCallback(
    (box: Box) => {
      onChangeRefId.current = onSelectionChange
        ? requestAnimationFrame(() => {
            onSelectionChange(box);
          })
        : undefined;
    },
    [onSelectionChange],
  );
  currentSelectionStart.current = onSelectionStart;
  currentSelectionEnd.current = onSelectionEnd;
  isEnabledRef.current = isEnabled;

  /**
   * Method to cancel selecting and reset internal data
   */
  const cancelCurrentSelection = useCallback(() => {
    startPoint.current = null;
    endPoint.current = null;
    isSelecting.current = false;
    containerRef.current?.clearSelectionBox();
    if (typeof onChangeRefId.current === 'number') {
      cancelAnimationFrame(onChangeRefId.current);
    }
  }, [containerRef]);

  /**
   * method to calculate point from event in context of the whole screen
   */
  const getPointFromEvent = useCallback(
    (event: MouseEvent | TouchEvent): Point => {
      const rect = containerRef.current?.getParentBoundingClientRect();
      const clientX = event instanceof MouseEvent ? event.clientX : event.touches[0].clientX;
      const clientY = event instanceof MouseEvent ? event.clientY : event.touches[0].clientY;

      return {
        x: clientX - (typeof rect?.left === 'number' ? rect.left : 0),
        y: clientY - (typeof rect?.top === 'number' ? rect.top : 0),
      };
    },
    [containerRef],
  );

  /**
   * Method called on mousemove event
   */
  const handleMouseMove = useCallback(
    (event: MouseEvent | TouchEvent, rect?: DOMRect) => {
      if (startPoint.current && endPoint.current) {
        if (!rect) {
          return;
        }

        const newSelectionBox = calculateSelectionBox({
          startPoint: startPoint.current,
          endPoint: endPoint.current,
        });

        // calculate box in context of container to compare with items' coordinates
        const boxInContainer: SelectionBox = {
          ...newSelectionBox,
          top: newSelectionBox.top + (rect?.top || 0),
          left: newSelectionBox.left + (rect?.left || 0),
        };

        // we detect move only after some small movement
        if (isValidSelectionStart(newSelectionBox)) {
          if (!isSelecting.current) {
            if (currentSelectionStart?.current) {
              currentSelectionStart.current(event);
            }
            isSelecting.current = true;
          }
          containerRef.current?.drawSelectionBox(newSelectionBox);
          currentSelectionChange.current?.(boxInContainer);
        } else if (isSelecting.current) {
          currentSelectionChange.current?.(boxInContainer);
        }
      } else {
        cancelCurrentSelection();
      }
    },
    [cancelCurrentSelection, containerRef],
  );

  const onMouseMove = useCallback(
    (event: MouseEvent | TouchEvent) => {
      if (!startPoint.current) {
        return;
      }

      const rect = containerRef.current?.getParentBoundingClientRect();
      endPoint.current = getPointFromEvent(event);
      handleMouseMove(event, rect);
    },
    [handleMouseMove, getPointFromEvent, containerRef],
  );

  const onMouseUp = useCallback(
    (event: MouseEvent | TouchEvent) => {
      /**
       * handle only left button up event, or touchend event
       */
      if ((event instanceof MouseEvent && event.button === 0) || event instanceof TouchEvent) {
        /**
         * If the user just clicked down and up in the same place without dragging,
         * we don't want to fire the onSelectionEnd event. We can do this
         * by checking if endPoint.current exists.
         */
        if (endPoint.current) {
          currentSelectionEnd.current?.(event);
        }

        cancelCurrentSelection();

        document.body.style.removeProperty('user-select');
        document.body.style.removeProperty('-webkit-user-select');

        (eventsElement || document.body).removeEventListener('mousemove', onMouseMove);
        (eventsElement || document.body).removeEventListener('touchmove', onMouseMove);
        window?.removeEventListener('mouseup', onMouseUp);
        window?.removeEventListener('touchend', onMouseUp);
      }
    },
    [eventsElement, cancelCurrentSelection, onMouseMove],
  );

  const onMouseDown = useCallback(
    (e: MouseEvent | TouchEvent) => {
      if ((e instanceof MouseEvent && e.button === 0 && isEnabledRef.current) || e instanceof TouchEvent) {
        if (typeof shouldStartSelecting === 'function' && !shouldStartSelecting(e.target, e)) {
          return;
        }

        // disable text selection for all document
        document.body.style.userSelect = 'none';
        document.body.style.webkitUserSelect = 'none';
        startPoint.current = getPointFromEvent(e);

        (eventsElement || document.body).addEventListener('mousemove', onMouseMove);
        (eventsElement || document.body).addEventListener('touchmove', onMouseMove);
        window?.addEventListener('mouseup', onMouseUp);
        window?.addEventListener('touchend', onMouseUp);

        if (e instanceof TouchEvent) {
          // prevent scrolling
          e.preventDefault();
        }
      }
    },
    [eventsElement, getPointFromEvent, onMouseMove, onMouseUp],
  );

  useEffect(() => {
    /**
     * On mount, add the mouse down listener to begin listening for dragging
     */
    (eventsElement || document.body).addEventListener('mousedown', onMouseDown);
    (eventsElement || document.body).addEventListener('touchstart', onMouseDown);

    /**
     * On unmount, remove any listeners that we're applied.
     */
    return () => {
      (eventsElement || document.body).removeEventListener('mousedown', onMouseDown);
      (eventsElement || document.body).removeEventListener('touchstart', onMouseDown);
      (eventsElement || document.body).removeEventListener('mousemove', onMouseMove);
      (eventsElement || document.body).removeEventListener('touchmove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('touchend', onMouseUp);
    };
  }, [eventsElement, onMouseDown, onMouseMove, onMouseUp]);

  return {
    cancelCurrentSelection,
  };
}

function isMinumumBoxArea(box: Box): boolean {
  return calculateBoxArea(box) > 10;
}
