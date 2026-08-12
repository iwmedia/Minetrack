// Two click day range picker: the first click sets the start, the second the
// end. Clicking an earlier day second swaps them, so the order never matters.
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000

const MONTH_FORMATTER = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' })

// 2024-01-01 was a Monday, used only to read localised weekday names
const WEEKDAY_LABELS = [...Array(7)].map((_, i) => WEEKDAY_FORMATTER.format(new Date(2024, 0, 1 + i)))

function startOfDay (date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

// Monday based, unlike Date#getDay which starts on Sunday
function weekdayIndex (date) {
  return (date.getDay() + 6) % 7
}

export class RangePicker {
  constructor (element, onSelect) {
    this._element = element
    this._onSelect = onSelect

    this._viewMonth = new Date()
    this._start = undefined
    this._hovered = undefined
    this._isOpen = false

    this._element.addEventListener('click', this.handleClick, false)
    this._element.addEventListener('mouseover', this.handleMouseOver, false)
  }

  isOpen () {
    return this._isOpen
  }

  toggle () {
    if (this._isOpen) {
      this.close()
    } else {
      this.open()
    }
  }

  open () {
    this._isOpen = true
    this._start = undefined
    this._hovered = undefined
    this._viewMonth = new Date()

    this._element.style.display = 'block'

    this.render()
  }

  close () {
    this._isOpen = false
    this._start = undefined
    this._hovered = undefined

    this._element.style.display = 'none'
  }

  handleClick = (event) => {
    const monthStep = event.target.getAttribute('minetrack-month-step')

    if (monthStep) {
      this._viewMonth = new Date(this._viewMonth.getFullYear(), this._viewMonth.getMonth() + parseInt(monthStep), 1)
      this.render()
      return
    }

    const day = event.target.getAttribute('minetrack-day')

    if (!day || event.target.classList.contains('day-cell-disabled')) {
      return
    }

    const value = parseInt(day)

    if (this._start === undefined) {
      this._start = value
      this._hovered = value

      // Only the classes change, so the clicked cell stays in the DOM and the
      // outside click check further up does not mistake it for a click away
      this.updateSelection()
      return
    }

    const from = Math.min(this._start, value)
    // The end day counts in full, so the window runs to its last millisecond
    const to = Math.max(this._start, value) + MILLIS_PER_DAY - 1

    this.close()
    this._onSelect(from, to)
  }

  handleMouseOver = (event) => {
    if (this._start === undefined) {
      return
    }

    const day = event.target.getAttribute('minetrack-day')

    if (day) {
      this._hovered = parseInt(day)
      this.updateSelection()
    }
  }

  // Rebuilds the whole month. Only called on open and when navigating months.
  render () {
    const today = startOfDay(new Date())
    const firstOfMonth = new Date(this._viewMonth.getFullYear(), this._viewMonth.getMonth(), 1)
    const daysInMonth = new Date(this._viewMonth.getFullYear(), this._viewMonth.getMonth() + 1, 0).getDate()

    let cells = ''

    for (let i = 0; i < weekdayIndex(firstOfMonth); i++) {
      cells += '<span class="day-cell day-cell-empty"></span>'
    }

    for (let dayOfMonth = 1; dayOfMonth <= daysInMonth; dayOfMonth++) {
      const value = new Date(this._viewMonth.getFullYear(), this._viewMonth.getMonth(), dayOfMonth).getTime()
      const disabled = value > today ? ' day-cell-disabled' : ''

      cells += `<a class="day-cell${disabled}" minetrack-day="${value}">${dayOfMonth}</a>`
    }

    this._element.innerHTML = `<div class="picker-header">
        <a class="picker-nav" minetrack-month-step="-1">&lsaquo;</a>
        <span class="picker-month">${MONTH_FORMATTER.format(this._viewMonth)}</span>
        <a class="picker-nav" minetrack-month-step="1">&rsaquo;</a>
      </div>
      <div class="picker-weekdays">${WEEKDAY_LABELS.map(label => `<span>${label}</span>`).join('')}</div>
      <div class="picker-days">${cells}</div>
      <div class="picker-hint"></div>`

    this.updateSelection()
  }

  // Toggles classes on the existing cells instead of rebuilding, so clicking
  // and hovering never detach the element the event came from
  updateSelection () {
    const from = this._start === undefined ? undefined : Math.min(this._start, this._hovered)
    const to = this._start === undefined ? undefined : Math.max(this._start, this._hovered)

    this._element.querySelectorAll('[minetrack-day]').forEach(cell => {
      const value = parseInt(cell.getAttribute('minetrack-day'))

      cell.classList.toggle('day-cell-in-range', from !== undefined && value >= from && value <= to)
      cell.classList.toggle('day-cell-anchor', value === this._start)
    })

    this._element.querySelector('.picker-hint').innerText = this._start === undefined
      ? 'Pick a start day'
      : 'Pick an end day'
  }
}
