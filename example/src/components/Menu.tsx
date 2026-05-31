import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {colors} from '../theme';

export type MenuItem = {
  key: string;
  title: string;
  checkable?: boolean;
  checked?: boolean;
  disabled?: boolean;
  onPress: () => void;
};

type Props = {
  visible: boolean;
  items: MenuItem[];
  onClose: () => void;
};

/** Android-style overflow (⋮) dropdown anchored to the top-right. */
export function Menu({visible, items, onClose}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.menu}>
          <ScrollView>
            {items.map(item => (
              <Pressable
                key={item.key}
                style={styles.item}
                disabled={item.disabled}
                onPress={() => {
                  onClose();
                  item.onPress();
                }}>
                <Text
                  style={[styles.itemText, item.disabled && styles.disabled]}>
                  {item.title}
                </Text>
                {item.checkable ? (
                  <Text style={styles.check}>{item.checked ? '☑' : '☐'}</Text>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'flex-end',
    paddingTop: 4,
    paddingRight: 4,
  },
  menu: {
    minWidth: 220,
    maxHeight: '80%',
    backgroundColor: colors.background,
    borderRadius: 4,
    paddingVertical: 4,
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: {width: 0, height: 2},
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  itemText: {flex: 1, fontSize: 16, color: colors.text},
  disabled: {color: colors.textSecondary, opacity: 0.5},
  check: {fontSize: 16, marginLeft: 16, color: colors.text},
});
