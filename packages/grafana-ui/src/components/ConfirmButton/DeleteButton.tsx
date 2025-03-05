import { ComponentSize } from '../../types/size';

import { ConfirmButton } from './ConfirmButton';
import { Icon } from '../Icon/Icon'

export interface Props {
  /** Confirm action callback */
  onConfirm(): void;
  /** Button size */
  size?: ComponentSize;
  /** Disable button click action */
  disabled?: boolean;
  'aria-label'?: string;
  /** Close after delete button is clicked */
  closeOnConfirm?: boolean;
}

export const DeleteButton = ({ size, disabled, onConfirm, 'aria-label': ariaLabel, closeOnConfirm }: Props) => {
  return (
    <ConfirmButton
      confirmText="Delete"
      confirmVariant="destructive"
      size={size || 'md'}
      disabled={disabled}
      onConfirm={onConfirm}
      closeOnConfirm={closeOnConfirm}
    >
      <Icon name="trash-alt" />
    </ConfirmButton>
  );
};
